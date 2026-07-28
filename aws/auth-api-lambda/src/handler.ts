/**
 * API Gateway HTTP API (v2) Lambda handler for the auth routes --
 * Phase 4's "port the Worker entrypoint to API Gateway + Lambda"
 * (docs/aws-migration-technical-design.md) for the auth slice
 * specifically, since that's the piece with every underlying primitive
 * already ported and tested (vibesdk-auth-orchestration and everything
 * it assembles).
 *
 * Ports worker/api/routes/authRoutes.ts + worker/api/controllers/auth/
 * controller.ts's HTTP-adapter behavior (status codes, redirect
 * locations, cookie names, response envelope shape) onto one Lambda
 * dispatched by `event.routeKey`, instead of Hono's router +
 * middleware chain -- there's no Hono here, `routeKey` string matching
 * plays the same role for a route table this small.
 *
 * CSRF protection (double-submit cookie, ported from
 * worker/services/csrf/CsrfService.ts) is enforced via vibesdk-csrf's
 * checkCsrf on every non-GET/HEAD/OPTIONS request that doesn't present
 * an explicit Authorization/X-API-Key credential -- see checkCsrf's
 * call below and the GET /api/auth/csrf-token case, which is the route
 * src/lib/api-client.ts's fetchCsrfToken already calls.
 *
 * NOT PORTED (see this package's README for the full list and why):
 * Cloudflare OAuth and the AI Gateway auto-connect side effect on its
 * callback (out of scope everywhere else in this migration too).
 *
 * Session listing/revocation and API-key management
 * (list/create/revoke/exchange-for-token) are wired to
 * `vibesdk-db-identity`'s `SessionStore`/`ApiKeyStore` directly,
 * alongside `AuthOrchestrator` (which only exposes token validation,
 * not session/key CRUD). `AuthOrchestrator.validateTokenAndGetUser`
 * already resolves the exchange endpoint's synthetic `api_key:<id>`
 * sessionId shape, so no changes were needed there.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuthOrchestrator, JWTUtils, SecurityError, type OAuthProvider } from 'vibesdk-auth-orchestration';
import { ApiKeyStore, SessionStore, UserStore } from 'vibesdk-db-identity';
import { buildCsrfCookie, checkCsrf, generateCsrfToken, CSRF_TOKEN_TTL_SECONDS } from 'vibesdk-csrf';
import {
	accessTokenCookie,
	clearAccessTokenCookie,
	clearOauthNonceCookie,
	oauthNonceCookie,
	readCookie,
	OAUTH_NONCE_COOKIE,
} from './cookies';
import { errorResponse, redirectResponse, successResponse } from './response';
import { generateApiKey, sha256Hash } from './api-key-crypto';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

const PUBLIC_BASE_URL = requireEnv('PUBLIC_BASE_URL');
const ORIGIN_VERIFY_SECRET = requireEnv('ORIGIN_VERIFY_SECRET');

/** Rejects requests that didn't come through the CloudFront distribution
 *  (which injects this header) -- closes the direct execute-api.*
 *  bypass around the WAF IP allowlist on CloudFront. */
function verifyOrigin(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
	if (event.headers?.['x-origin-verify'] !== ORIGIN_VERIFY_SECRET) {
		return errorResponse('Forbidden', 403);
	}
	return null;
}

let cachedAuth: AuthOrchestrator | null = null;
let cachedSessions: SessionStore | null = null;
let cachedApiKeys: ApiKeyStore | null = null;
let cachedUsers: UserStore | null = null;
let ddbClientOverride: DynamoDBDocumentClient | null = null;

/** Test-only: inject a fake DynamoDB client instead of a real one, and
 *  drop the cached AuthOrchestrator so the next call rebuilds against
 *  it. Mirrors JWTUtils.resetInstanceForTests in vibesdk-auth-orchestration. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedAuth = null;
	cachedSessions = null;
	cachedApiKeys = null;
	cachedUsers = null;
}

function getDdb(): DynamoDBDocumentClient {
	return ddbClientOverride ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function getSessions(): SessionStore {
	if (cachedSessions) return cachedSessions;
	cachedSessions = new SessionStore(getDdb(), requireEnv('IDENTITY_TABLE'));
	return cachedSessions;
}

function getApiKeys(): ApiKeyStore {
	if (cachedApiKeys) return cachedApiKeys;
	cachedApiKeys = new ApiKeyStore(getDdb(), requireEnv('IDENTITY_TABLE'));
	return cachedApiKeys;
}

function getUsers(): UserStore {
	if (cachedUsers) return cachedUsers;
	cachedUsers = new UserStore(getDdb(), requireEnv('IDENTITY_TABLE'));
	return cachedUsers;
}

const MAX_API_KEYS_PER_USER = 25;

/** Built once per warm Lambda instance, not per invocation. */
function getAuth(): AuthOrchestrator {
	if (cachedAuth) return cachedAuth;

	const ddb = getDdb();
	cachedAuth = new AuthOrchestrator({
		ddb,
		identityTable: requireEnv('IDENTITY_TABLE'),
		authFlowsTable: requireEnv('AUTH_FLOWS_TABLE'),
		auditTable: process.env.AUDIT_TABLE,
		jwtSecret: requireEnv('JWT_SECRET'),
		allowedEmail: process.env.ALLOWED_EMAIL,
		oauth: {
			github:
				process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
					? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
					: undefined,
			google:
				process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
					? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
					: undefined,
		},
	});
	return cachedAuth;
}

function isOAuthProvider(value: string | undefined): value is OAuthProvider {
	return value === 'github' || value === 'google';
}

function parseJsonBody(event: APIGatewayProxyEventV2): Record<string, unknown> | null {
	if (!event.body) return null;
	try {
		const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function requestFor(event: APIGatewayProxyEventV2): Request {
	// AuthOrchestrator only reads headers off this (extractRequestMetadata) --
	// a synthetic Request carrying API Gateway's forwarded headers is enough,
	// no real body/method fidelity needed.
	const headers = new Headers();
	for (const [key, value] of Object.entries(event.headers ?? {})) {
		if (value) headers.set(key, value);
	}
	if (!headers.has('CF-Connecting-IP') && event.requestContext.http.sourceIp) {
		headers.set('X-Real-IP', event.requestContext.http.sourceIp);
	}
	return new Request(PUBLIC_BASE_URL, { headers });
}

async function getBearerOrCookieToken(event: APIGatewayProxyEventV2): Promise<string | null> {
	const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
	if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
	return readCookie(event.cookies, 'accessToken');
}

async function requireUser(event: APIGatewayProxyEventV2) {
	const token = await getBearerOrCookieToken(event);
	if (!token) return null;
	return getAuth().validateTokenAndGetUser(token);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const originError = verifyOrigin(event);
	if (originError) return originError;

	const csrfResult = checkCsrf(event);
	if (!csrfResult.ok) return errorResponse('CSRF validation failed', 403);

	const auth = getAuth();
	const routeKey = event.routeKey;
	const provider = event.pathParameters?.provider;
	const sessionIdParam = event.pathParameters?.sessionId;
	const keyId = event.pathParameters?.keyId;

	try {
		switch (routeKey) {
			case 'GET /api/auth/csrf-token': {
				// Ported from CsrfService.enforce's GET-request cookie-minting
				// path -- src/lib/api-client.ts's fetchCsrfToken calls exactly
				// this route and reads `data.token`/`data.expiresIn` from the
				// response body (never document.cookie).
				const token = generateCsrfToken();
				return successResponse({ token, expiresIn: CSRF_TOKEN_TTL_SECONDS }, 200, [buildCsrfCookie(token)]);
			}

			case 'POST /api/auth/register': {
				const body = parseJsonBody(event);
				if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
					return errorResponse('email and password are required', 400);
				}
				const result = await auth.register(
					{ email: body.email, password: body.password, name: typeof body.name === 'string' ? body.name : undefined },
					requestFor(event),
				);
				return successResponse(
					{ user: result.user, sessionId: result.sessionId, expiresAt: result.expiresAt },
					200,
					[accessTokenCookie(result.accessToken, 3 * 24 * 60 * 60)],
				);
			}

			case 'POST /api/auth/login': {
				const body = parseJsonBody(event);
				if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
					return errorResponse('email and password are required', 400);
				}
				const result = await auth.login({ email: body.email, password: body.password }, requestFor(event));
				return successResponse(
					{ user: result.user, sessionId: result.sessionId, expiresAt: result.expiresAt },
					200,
					[accessTokenCookie(result.accessToken, 3 * 24 * 60 * 60)],
				);
			}

			case 'POST /api/auth/logout': {
				const session = await requireUser(event);
				if (session) {
					await auth.logout(session.sessionId).catch(() => {});
				}
				return successResponse({ success: true, message: 'Logged out successfully' }, 200, [clearAccessTokenCookie()]);
			}

			case 'GET /api/auth/check': {
				const session = await requireUser(event);
				if (!session) return successResponse({ authenticated: false, user: null });
				return successResponse({
					authenticated: true,
					user: { id: session.user.id, email: session.user.email, displayName: session.user.displayName },
					sessionId: session.sessionId,
				});
			}

			case 'GET /api/auth/profile': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				return successResponse({ user: session.user, sessionId: session.sessionId });
			}

			case 'PUT /api/auth/profile': {
				// Same underlying operation as PUT /api/user/profile
				// (aws/user-api-lambda) -- the original registers this as
				// two routes (AuthController.updateProfile /
				// UserController.updateProfile) against the same
				// UserService method.
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const body = parseJsonBody(event);
				const username = typeof body?.username === 'string' ? body.username : undefined;
				const displayName = typeof body?.displayName === 'string' ? body.displayName : undefined;
				const bio = typeof body?.bio === 'string' ? body.bio : undefined;
				const themeRaw = body?.theme;
				const theme = themeRaw === 'light' || themeRaw === 'dark' || themeRaw === 'system' ? themeRaw : undefined;

				const result = await getUsers().updateUserProfileWithValidation(session.user.id, { username, displayName, bio, theme });
				if (!result.success) return errorResponse(result.message, 400);
				return successResponse(result);
			}

			case 'POST /api/auth/verify-email': {
				const body = parseJsonBody(event);
				if (!body || typeof body.email !== 'string' || typeof body.otp !== 'string') {
					return errorResponse('email and otp are required', 400);
				}
				const result = await auth.verifyEmailWithOtp(body.email, body.otp, requestFor(event));
				return successResponse(
					{ user: result.user, sessionId: result.sessionId, expiresAt: result.expiresAt },
					200,
					[accessTokenCookie(result.accessToken, 3 * 24 * 60 * 60)],
				);
			}

			case 'POST /api/auth/resend-verification': {
				const body = parseJsonBody(event);
				if (!body || typeof body.email !== 'string') return errorResponse('email is required', 400);
				await auth.resendVerificationOtp(body.email);
				return successResponse({ success: true });
			}

			case 'GET /api/auth/oauth/{provider}': {
				if (!isOAuthProvider(provider)) return errorResponse('Unsupported OAuth provider', 400);
				const redirectUrl = event.queryStringParameters?.redirect_url;
				const { authUrl, nonce } = await auth.getOAuthAuthorizationUrl(provider, PUBLIC_BASE_URL, redirectUrl);
				return redirectResponse(authUrl, [oauthNonceCookie(nonce)]);
			}

			case 'GET /api/auth/link/{provider}': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!isOAuthProvider(provider)) return errorResponse('Unsupported OAuth provider', 400);
				const { authUrl, nonce } = await auth.getOAuthAuthorizationUrl(
					provider,
					PUBLIC_BASE_URL,
					'/settings',
					session.user.id,
				);
				return redirectResponse(authUrl, [oauthNonceCookie(nonce)]);
			}

			case 'GET /api/auth/callback/{provider}': {
				if (!isOAuthProvider(provider)) return redirectResponse(`${PUBLIC_BASE_URL}/?error=oauth_failed`);

				const code = event.queryStringParameters?.code;
				const state = event.queryStringParameters?.state;
				const oauthError = event.queryStringParameters?.error;
				if (oauthError) return redirectResponse(`${PUBLIC_BASE_URL}/?error=oauth_failed`);
				if (!code || !state) return redirectResponse(`${PUBLIC_BASE_URL}/?error=missing_params`);

				const cookieNonce = readCookie(event.cookies, OAUTH_NONCE_COOKIE);

				const linkUserId = await auth.getPendingLinkUserId(state);
				if (linkUserId) {
					const session = await requireUser(event);
					if (!session || session.user.id !== linkUserId) {
						return redirectResponse(`${PUBLIC_BASE_URL}/settings?error=link_unauthorized`);
					}
					try {
						const linkResult = await auth.completeOAuthLink(
							provider,
							code,
							state,
							PUBLIC_BASE_URL,
							cookieNonce,
							session.user.id,
						);
						const location = linkResult.redirectUrl ?? `${PUBLIC_BASE_URL}/settings?linked=${provider}`;
						return redirectResponse(location, [clearOauthNonceCookie()]);
					} catch (error) {
						const reason = error instanceof SecurityError && error.statusCode === 409 ? 'link_conflict' : 'link_failed';
						return redirectResponse(`${PUBLIC_BASE_URL}/settings?error=${reason}`);
					}
				}

				const result = await auth.handleOAuthCallback(provider, code, state, PUBLIC_BASE_URL, cookieNonce);
				const location = result.redirectUrl ?? `${PUBLIC_BASE_URL}/`;
				return redirectResponse(location, [
					accessTokenCookie(result.accessToken, 3 * 24 * 60 * 60),
					clearOauthNonceCookie(),
				]);
			}

			case 'GET /api/auth/identities': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const identities = await auth.getUserIdentities(session.user.id);
				return successResponse({
					identities: identities.map((i) => ({
						provider: i.provider,
						email: i.email,
						emailVerified: !!i.emailVerified,
						createdAt: i.createdAt,
					})),
				});
			}

			case 'DELETE /api/auth/identities/{provider}': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!isOAuthProvider(provider)) return errorResponse('Unsupported OAuth provider', 400);
				await auth.unlinkOAuthIdentity(session.user.id, provider);
				return successResponse({ message: 'Provider unlinked successfully' });
			}

			case 'GET /api/auth/sessions': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const sessions = await getSessions().getUserSessions(session.user.id);
				return successResponse({ sessions });
			}

			case 'DELETE /api/auth/sessions/{sessionId}': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!sessionIdParam) return errorResponse('Session ID is required', 400);
				await getSessions().revokeUserSession(sessionIdParam, session.user.id);
				return successResponse({ message: 'Session revoked successfully' });
			}

			case 'GET /api/auth/api-keys': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const keys = await getApiKeys().getUserApiKeys(session.user.id);
				return successResponse({
					keys: keys.map((k) => ({
						id: k.id,
						name: k.name,
						keyPreview: k.keyPreview,
						createdAt: k.createdAt,
						lastUsed: k.lastUsed,
						isActive: !!k.isActive,
					})),
				});
			}

			case 'POST /api/auth/api-keys': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const body = parseJsonBody(event);
				const name = typeof body?.name === 'string' ? body.name.trim() : '';
				if (!name) return errorResponse('API key name is required', 400);
				const sanitizedName = name.substring(0, 100);

				const apiKeys = getApiKeys();
				const activeCount = await apiKeys.getActiveApiKeyCount(session.user.id);
				if (activeCount >= MAX_API_KEYS_PER_USER) {
					return errorResponse(
						`Maximum of ${MAX_API_KEYS_PER_USER} API keys allowed. Please revoke an existing key before creating a new one.`,
						400,
					);
				}

				const { key, keyHash, keyPreview } = generateApiKey();
				await apiKeys.createApiKey({ userId: session.user.id, name: sanitizedName, keyHash, keyPreview });

				return successResponse({
					key, // Returned only once -- the hash is all that's stored.
					keyPreview,
					name: sanitizedName,
					message: 'API key created successfully',
				});
			}

			case 'DELETE /api/auth/api-keys/{keyId}': {
				const session = await requireUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!keyId) return errorResponse('API key ID is required', 400);
				await getApiKeys().revokeApiKey(keyId, session.user.id);
				return successResponse({ message: 'API key revoked successfully' });
			}

			case 'POST /api/auth/exchange-api-key': {
				// Ported from AuthController.exchangeApiKey -- exchanges a
				// long-lived API key for a short-lived (15m) access token
				// carrying a synthetic `api_key:<id>` sessionId, which
				// AuthOrchestrator.validateTokenAndGetUser already resolves
				// back to the source key (see its own module).
				const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
				const xApiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-API-Key'];

				let apiKeyRaw: string | null = null;
				if (authHeader?.toLowerCase().startsWith('bearer ')) {
					apiKeyRaw = authHeader.slice(7).trim();
				} else if (xApiKey) {
					apiKeyRaw = xApiKey.trim();
				}

				if (!apiKeyRaw) return errorResponse('Missing API key', 401);
				if (apiKeyRaw.length > 256) return errorResponse('Invalid API key', 401);
				if (!/^[A-Za-z0-9_-]+$/.test(apiKeyRaw)) return errorResponse('Invalid API key', 401);

				const apiKeys = getApiKeys();
				const keyHash = sha256Hash(apiKeyRaw);
				const apiKey = await apiKeys.findApiKeyByHash(keyHash);
				if (!apiKey) return errorResponse('Invalid API key', 401);

				const user = await auth.getUserForAuth(apiKey.userId);
				if (!user) return errorResponse('Invalid API key', 401);

				const expiresIn = 15 * 60;
				const accessToken = await JWTUtils.getInstance(requireEnv('JWT_SECRET')).createToken(
					{ sub: user.id, email: user.email, type: 'access', sessionId: `api_key:${apiKey.id}` },
					expiresIn,
				);
				await apiKeys.updateApiKeyLastUsed(apiKey.id);

				return successResponse({
					accessToken,
					expiresIn,
					expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
				});
			}

			default:
				return errorResponse('Not found', 404);
		}
	} catch (error) {
		if (error instanceof SecurityError) {
			return errorResponse(error.message, error.statusCode);
		}
		return errorResponse('Internal server error', 500);
	}
}
