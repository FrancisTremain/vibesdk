/**
 * API Gateway HTTP API (v2) Lambda handler for the app listing/detail/
 * favorite/star/visibility/delete routes
 * (worker/api/routes/appRoutes.ts, worker/api/controllers/apps/
 * controller.ts + worker/api/controllers/appView/controller.ts), wired
 * to vibesdk-db-apps for storage and vibesdk-auth-orchestration for
 * token validation only (`AuthOrchestrator.validateTokenAndGetUser`) --
 * same routing-by-`routeKey` shape as `aws/auth-api-lambda`.
 *
 * NOT PORTED (see README): favorites listing (`AppStore` doesn't have
 * `getFavoriteAppsOnly` -- excluded when `aws/db-apps` was built,
 * nothing to wire here), git-clone-token/preview-token routes (deploy-
 * token issuance, out of scope until the sandbox/deploy port), fork
 * (disabled in the original too).
 *
 * GET /api/apps/public is rate-limited via vibesdk-rate-limit, matching
 * the original's enforcePublicAppsRateLimit
 * (worker/services/rate-limit/rateLimits.ts).
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuthOrchestrator } from 'vibesdk-auth-orchestration';
import { AppStore } from 'vibesdk-db-apps';
import { DynamoRateLimiter } from 'vibesdk-rate-limit';
import { toPublicAppListItem } from './public-app-dto';
import { parsePublicAppsQuery } from './public-apps-query';
import { errorResponse, successResponse } from './response';
import { getPublicAppsRateLimitIdentifier } from './rate-limit-identifier';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

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

let cachedApps: AppStore | null = null;
let cachedAuth: AuthOrchestrator | null = null;
let cachedRateLimiter: DynamoRateLimiter | null = null;
let ddbClientOverride: DynamoDBDocumentClient | null = null;

/** Test-only, mirrors aws/auth-api-lambda's setDdbClientForTests. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedApps = null;
	cachedAuth = null;
	cachedRateLimiter = null;
}

function getDdb(): DynamoDBDocumentClient {
	return ddbClientOverride ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function getApps(): AppStore {
	if (cachedApps) return cachedApps;
	cachedApps = new AppStore(getDdb(), requireEnv('APPS_TABLE'));
	return cachedApps;
}

function getRateLimiter(): DynamoRateLimiter {
	if (cachedRateLimiter) return cachedRateLimiter;
	cachedRateLimiter = new DynamoRateLimiter(getDdb(), requireEnv('RATE_LIMITS_TABLE'));
	return cachedRateLimiter;
}

/** Matches worker/services/rate-limit/config.ts's DEFAULT_RATE_LIMIT_SETTINGS.publicApps. */
const PUBLIC_APPS_RATE_LIMIT = { limit: 120, period: 60, burst: 40, burstWindow: 10 };

function getAuth(): AuthOrchestrator {
	if (cachedAuth) return cachedAuth;
	cachedAuth = new AuthOrchestrator({
		ddb: getDdb(),
		identityTable: requireEnv('IDENTITY_TABLE'),
		authFlowsTable: requireEnv('AUTH_FLOWS_TABLE'),
		jwtSecret: requireEnv('JWT_SECRET'),
	});
	return cachedAuth;
}

async function getBearerOrCookieToken(event: APIGatewayProxyEventV2): Promise<string | null> {
	const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
	if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
	const cookieEntry = event.cookies?.find((c) => c.trim().startsWith('accessToken='));
	return cookieEntry ? decodeURIComponent(cookieEntry.split('=').slice(1).join('=')) : null;
}

/** Authenticated if a valid token is present; null otherwise -- callers
 *  decide whether that's an error (protected routes) or fine (public
 *  routes with optional personalization). */
async function getUser(event: APIGatewayProxyEventV2) {
	const token = await getBearerOrCookieToken(event);
	if (!token) return null;
	return getAuth().validateTokenAndGetUser(token);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const originError = verifyOrigin(event);
	if (originError) return originError;

	const apps = getApps();
	const routeKey = event.routeKey;
	const appId = event.pathParameters?.id;

	try {
		switch (routeKey) {
			case 'GET /api/status': {
				// Ported from worker/api/controllers/status/controller.ts.
				// Global platform messaging (context.config.globalMessaging)
				// has no AWS equivalent config surface yet, so this always
				// reports no active message rather than fabricating one.
				return successResponse({
					globalUserMessage: '',
					changeLogs: '',
					hasActiveMessage: false,
				});
			}

			case 'GET /api/capabilities': {
				// Ported from worker/api/controllers/capabilities/controller.ts.
				// The original reads PLATFORM_CAPABILITIES from wrangler.jsonc
				// config; AWS has no equivalent env surface, so feature
				// enablement is hardcoded to what aws/agent-runtime actually
				// supports today: a single generic agentic generation flow
				// (see aws/agent-runtime/src/generation.ts -- no per-project-
				// type behavior, no SpaceDO/think support), not the "app"
				// feature's live-reload/think behavior or "presentation"'s
				// export formats.
				return successResponse({
					features: [
						{
							id: 'app',
							name: 'Application',
							description: 'Full-stack web applications',
							enabled: false,
							capabilities: {
								hasPreview: true,
								hasLiveReload: false,
								requiresSandbox: true,
								requiresWebSocket: true,
								supportedViews: ['editor', 'preview', 'docs'],
								defaultView: 'editor',
								supportedExports: ['github'],
								hasCustomHeaderActions: false,
								hasCustomSidebar: false,
								hasCustomFileFilter: false,
								behaviorType: 'agentic',
							},
						},
						{
							id: 'presentation',
							name: 'Presentation',
							description: 'Interactive slide presentations',
							enabled: false,
							capabilities: {
								hasPreview: true,
								hasLiveReload: true,
								requiresSandbox: true,
								requiresWebSocket: true,
								supportedViews: ['editor', 'preview', 'docs'],
								defaultView: 'preview',
								supportedExports: ['github'],
								hasCustomHeaderActions: false,
								hasCustomSidebar: false,
								hasCustomFileFilter: false,
								behaviorType: 'agentic',
							},
						},
						{
							id: 'general',
							name: 'General',
							description: 'General-purpose code generation',
							enabled: true,
							capabilities: {
								hasPreview: false,
								hasLiveReload: false,
								requiresSandbox: false,
								requiresWebSocket: true,
								supportedViews: ['editor', 'docs'],
								defaultView: 'editor',
								supportedExports: ['github'],
								hasCustomHeaderActions: false,
								hasCustomSidebar: false,
								hasCustomFileFilter: false,
								behaviorType: 'agentic',
							},
						},
					],
					version: '1.0.0-aws',
				});
			}

			case 'GET /api/apps/public': {
				const session = await getUser(event);

				// Layered on top of CloudFront's IP allowlist to make
				// bulk-harvest/scan attacks more expensive even from an
				// already-allowlisted client, matching the original's
				// enforcePublicAppsRateLimit (worker/services/rate-limit/
				// rateLimits.ts). Fails open on a rate-limiter error rather
				// than 500ing a listing request over an infra hiccup, same
				// as the original's catch-and-log behavior.
				const identifier = getPublicAppsRateLimitIdentifier(event, session?.user.id);
				try {
					const rateLimit = await getRateLimiter().increment(`platform:publicApps:${identifier}`, PUBLIC_APPS_RATE_LIMIT);
					if (!rateLimit.success) return errorResponse('Too many requests', 429);
				} catch {
					// Rate limiter unavailable -- fail open, see comment above.
				}

				const query = new URLSearchParams(event.queryStringParameters as Record<string, string> | undefined);
				const parsed = parsePublicAppsQuery(query);
				if (!parsed.ok) return errorResponse(parsed.error, 400);

				const sortParam = query.get('sort');
				const sort = sortParam === 'oldest' ? 'oldest' : 'recent';
				const framework = query.get('framework') || undefined;

				const result = await apps.getPublicApps({
					limit: parsed.value.limit,
					offset: parsed.value.offset,
					sort,
					framework,
					search: parsed.value.search,
					userId: session?.user.id,
				});

				return successResponse({
					apps: result.data.map(toPublicAppListItem),
					pagination: result.pagination,
				});
			}

			case 'GET /api/apps': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const userApps = await apps.getUserAppsWithFavorites(session.user.id);
				return successResponse({ apps: userApps });
			}

			case 'GET /api/apps/recent': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const recentApps = await apps.getRecentAppsWithFavorites(session.user.id, 10);
				return successResponse({ apps: recentApps });
			}

			case 'GET /api/apps/{id}': {
				if (!appId) return errorResponse('App ID is required', 400);
				const session = await getUser(event);

				const app = await apps.getAppDetails(appId, session?.user.id);
				if (!app) return errorResponse('App not found', 404);
				if (app.visibility === 'private' && app.userId !== session?.user.id) {
					return errorResponse('App not found', 404);
				}

				if (session) {
					await apps.recordAppView(appId, { userId: session.user.id });
				}

				return successResponse({ app: toPublicAppListItem(app) });
			}

			case 'POST /api/apps/{id}/star': {
				if (!appId) return errorResponse('App ID is required', 400);
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const app = await apps.getSingleAppWithFavoriteStatus(appId, session.user.id);
				if (!app) return errorResponse('App not found', 404);

				const result = await apps.toggleAppStar(session.user.id, appId);
				return successResponse(result);
			}

			case 'POST /api/apps/{id}/favorite': {
				if (!appId) return errorResponse('App ID is required', 400);
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const ownership = await apps.checkAppOwnership(appId, session.user.id);
				if (!ownership.exists) return errorResponse('App not found', 404);
				if (!ownership.isOwner && ownership.visibility !== 'public') {
					return errorResponse('App not found', 404);
				}

				const result = await apps.toggleAppFavorite(session.user.id, appId);
				return successResponse(result);
			}

			case 'PUT /api/apps/{id}/visibility': {
				if (!appId) return errorResponse('App ID is required', 400);
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const rawBody = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body) : null;
				const visibility = rawBody?.visibility;
				if (visibility !== 'private' && visibility !== 'public') {
					return errorResponse('Visibility must be either "private" or "public"', 400);
				}

				const result = await apps.updateAppVisibility(appId, session.user.id, visibility);
				if (!result.success) {
					const statusCode = result.error === 'App not found' ? 404 : result.error?.includes('only change visibility') ? 403 : 500;
					return errorResponse(result.error ?? 'Failed to update app visibility', statusCode);
				}
				return successResponse({ app: result.app, message: `App visibility updated to ${visibility}` });
			}

			case 'DELETE /api/apps/{id}': {
				if (!appId) return errorResponse('App ID is required', 400);
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const result = await apps.deleteApp(appId, session.user.id);
				if (!result.success) {
					const statusCode = result.error === 'App not found' ? 404 : result.error?.includes('only delete') ? 403 : 500;
					return errorResponse(result.error ?? 'Failed to delete app', statusCode);
				}
				return successResponse({ success: true, message: 'App deleted successfully' });
			}

			default:
				return errorResponse('Not found', 404);
		}
	} catch {
		return errorResponse('Internal server error', 500);
	}
}
