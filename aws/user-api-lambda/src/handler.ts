/**
 * API Gateway HTTP API (v2) Lambda handler for user stats
 * (worker/api/routes/statsRoutes.ts, worker/api/controllers/stats/
 * controller.ts), custom model-provider listing
 * (worker/api/routes/modelProviderRoutes.ts,
 * worker/api/controllers/modelProviders/controller.ts), model-config
 * CRUD (worker/api/routes/modelConfigRoutes.ts,
 * worker/api/controllers/modelConfig/controller.ts), and the user
 * dashboard's own-apps listing + profile update
 * (worker/api/routes/userRoutes.ts, worker/api/controllers/user/
 * controller.ts). Same `event.routeKey`-switch shape as
 * `aws/auth-api-lambda`/`aws/apps-api-lambda`.
 *
 * Model-config CRUD is wired to `vibesdk-model-config-defaults`, a
 * duplicated snapshot of `AGENT_CONFIG`/`AGENT_CONSTRAINTS` and the
 * merge/constraint-validation logic those routes need -- see that
 * package's README for why duplication (not a shared import from
 * `worker/`) was the right call for now, and what would change that.
 *
 * `ModelProvidersController.createProvider`/`updateProvider`/
 * `deleteProvider` are themselves disabled in the live product right
 * now (`worker/api/controllers/modelProviders/controller.ts` returns
 * 503 "Custom model providers are temporarily disabled" for all three,
 * unconditionally, before touching the database). This handler mirrors
 * that exact current behavior rather than reviving a disabled feature
 * -- see the routes below. `testModelConfig`/`testProvider`'s
 * live-network-call paths aren't ported at all (out of scope for a
 * storage-layer Lambda).
 *
 * CSRF protection (double-submit cookie) is enforced via vibesdk-csrf's
 * checkCsrf on every non-GET/HEAD/OPTIONS request without an explicit
 * Authorization/X-API-Key credential -- see aws/auth-api-lambda's
 * GET /api/auth/csrf-token, which mints the cookie this checks against.
 */

import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';
import { AuthOrchestrator } from 'vibesdk-auth-orchestration';
import { AnalyticsStore } from 'vibesdk-db-analytics';
import { AppStore, type UserAppQueryOptions } from 'vibesdk-db-apps';
import { UserStore, HarnessCredentialsStore } from 'vibesdk-db-identity';
import { UsageStore } from 'vibesdk-db-llm-usage';
import { checkCsrf } from 'vibesdk-csrf';
import { ModelConfigStore, ModelProviderStore } from 'vibesdk-db-model-config';
import {
	AGENT_CONFIG,
	resolveModelConfig,
	validateModel,
	validateModelAccessForEnvironment,
	type AgentActionKey,
} from 'vibesdk-model-config-defaults';
import { errorResponse, successResponse, ndjsonResponse } from './response';

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

let cachedAnalytics: AnalyticsStore | null = null;
let cachedProviders: ModelProviderStore | null = null;
let cachedModelConfigs: ModelConfigStore | null = null;
let cachedAuth: AuthOrchestrator | null = null;
let cachedApps: AppStore | null = null;
let cachedUsers: UserStore | null = null;
let cachedUsage: UsageStore | null = null;
let cachedCredentials: HarnessCredentialsStore | null = null;
let cachedKms: Pick<KMSClient, 'send'> | null = null;
let ddbClientOverride: DynamoDBDocumentClient | null = null;
let kmsClientOverride: Pick<KMSClient, 'send'> | null = null;

/** Test-only, mirrors the sibling Lambda packages' setDdbClientForTests. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedAnalytics = null;
	cachedProviders = null;
	cachedModelConfigs = null;
	cachedAuth = null;
	cachedApps = null;
	cachedUsers = null;
	cachedUsage = null;
	cachedCredentials = null;
}

/** Test-only, KMS's own equivalent of setDdbClientForTests. */
export function setKmsClientForTests(client: Pick<KMSClient, 'send'> | null): void {
	kmsClientOverride = client;
	cachedKms = null;
}

function getDdb(): DynamoDBDocumentClient {
	return ddbClientOverride ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function getAnalytics(): AnalyticsStore {
	if (cachedAnalytics) return cachedAnalytics;
	cachedAnalytics = new AnalyticsStore(getDdb(), requireEnv('APPS_TABLE'));
	return cachedAnalytics;
}

function getProviders(): ModelProviderStore {
	if (cachedProviders) return cachedProviders;
	cachedProviders = new ModelProviderStore(getDdb(), requireEnv('MODEL_CONFIG_TABLE'));
	return cachedProviders;
}

function getModelConfigs(): ModelConfigStore {
	if (cachedModelConfigs) return cachedModelConfigs;
	cachedModelConfigs = new ModelConfigStore(getDdb(), requireEnv('MODEL_CONFIG_TABLE'));
	return cachedModelConfigs;
}

function getApps(): AppStore {
	if (cachedApps) return cachedApps;
	cachedApps = new AppStore(getDdb(), requireEnv('APPS_TABLE'));
	return cachedApps;
}

function getUsers(): UserStore {
	if (cachedUsers) return cachedUsers;
	cachedUsers = new UserStore(getDdb(), requireEnv('IDENTITY_TABLE'));
	return cachedUsers;
}

function getCredentials(): HarnessCredentialsStore {
	if (cachedCredentials) return cachedCredentials;
	cachedCredentials = new HarnessCredentialsStore(getDdb(), requireEnv('IDENTITY_TABLE'));
	return cachedCredentials;
}

function getKms(): Pick<KMSClient, 'send'> {
	return kmsClientOverride ?? (cachedKms ??= new KMSClient({}));
}

function getUsage(): UsageStore {
	if (cachedUsage) return cachedUsage;
	// Cast at the package boundary -- see aws/agent-runtime/src/usage.ts's
	// identical comment: vibesdk-db-llm-usage's independently-installed
	// @aws-sdk/lib-dynamodb copy can drift to a different patch version
	// than this package's, which TS treats as structurally distinct
	// despite both being real DynamoDBDocumentClient instances at runtime.
	cachedUsage = new UsageStore(getDdb() as unknown as ConstructorParameters<typeof UsageStore>[0], requireEnv('LLM_USAGE_TABLE'));
	return cachedUsage;
}

/** GET /api/agent/{id}/analytics's ownership check: agent ids are
 *  aws/agent-runtime session ids, whose only owner record is the
 *  session item itself (session_id -> user_id), not a dedicated
 *  db-* store the way apps/identity have one. */
async function isSessionOwner(sessionId: string, userId: string): Promise<boolean> {
	const result = await getDdb().send(
		new GetCommand({ TableName: requireEnv('AGENT_SESSIONS_TABLE'), Key: { session_id: sessionId } }),
	);
	const item = result.Item as { user_id?: string } | undefined;
	return item?.user_id === userId;
}

const VALID_ANALYTICS_DAYS_RANGE = { min: 1, max: 365 };

function parseAnalyticsDays(event: APIGatewayProxyEventV2): number | null {
	const raw = event.queryStringParameters?.days;
	if (raw === undefined) return 30;
	const days = parseInt(raw, 10);
	if (!Number.isInteger(days) || days < VALID_ANALYTICS_DAYS_RANGE.min || days > VALID_ANALYTICS_DAYS_RANGE.max) return null;
	return days;
}

function isAgentActionKey(value: string | undefined): value is AgentActionKey {
	return !!value && value in AGENT_CONFIG;
}

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

async function getUser(event: APIGatewayProxyEventV2) {
	const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
	let token: string | null = null;
	if (authHeader?.startsWith('Bearer ')) {
		token = authHeader.slice(7);
	} else {
		const cookieEntry = event.cookies?.find((c) => c.trim().startsWith('accessToken='));
		token = cookieEntry ? decodeURIComponent(cookieEntry.split('=').slice(1).join('=')) : null;
	}
	if (!token) return null;
	return getAuth().validateTokenAndGetUser(token);
}

const PROVIDERS_DISABLED_MESSAGE = 'Custom model providers are temporarily disabled. Please use BYOK (Bring Your Own Key) in the vault settings.';

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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const originError = verifyOrigin(event);
	if (originError) return originError;

	const csrfResult = checkCsrf(event);
	if (!csrfResult.ok) return errorResponse('CSRF validation failed', 403);

	const routeKey = event.routeKey;
	const providerId = event.pathParameters?.id;
	const agentAction = event.pathParameters?.agentAction;

	try {
		switch (routeKey) {
			case 'GET /api/user/apps': {
				// Ported from worker/api/controllers/user/controller.ts's
				// getApps -- see vibesdk-db-apps's getUserAppsPaginated for
				// what's simplified (recent/oldest sort only, no ranked
				// query -- same reduction as GET /api/apps/public).
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const query = new URLSearchParams(event.queryStringParameters as Record<string, string> | undefined);
				const page = Math.max(parseInt(query.get('page') || '1') || 1, 1);
				const limit = Math.min(Math.max(parseInt(query.get('limit') || '20') || 20, 1), 100);
				const status = query.get('status');
				const visibility = query.get('visibility');
				const options: UserAppQueryOptions = {
					limit,
					offset: (page - 1) * limit,
					status: status === 'generating' || status === 'completed' ? status : undefined,
					visibility: visibility === 'private' || visibility === 'public' ? visibility : undefined,
					framework: query.get('framework') || undefined,
					search: query.get('search') || undefined,
					sort: query.get('sort') === 'oldest' ? 'oldest' : 'recent',
					order: query.get('order') === 'asc' ? 'asc' : query.get('order') === 'desc' ? 'desc' : undefined,
					period: (['day', 'week', 'month'] as const).includes(query.get('period') as never)
						? (query.get('period') as 'day' | 'week' | 'month')
						: 'all',
				};

				const result = await getApps().getUserAppsPaginated(session.user.id, options);
				return successResponse({ apps: result.data, pagination: result.pagination });
			}

			case 'PUT /api/user/profile': {
				// Ported from worker/api/controllers/user/controller.ts's
				// updateProfile -- vibesdk-db-identity's
				// updateUserProfileWithValidation already carries the full
				// original validation (username format/length/reserved
				// words, uniqueness), no reduction here.
				const session = await getUser(event);
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

			case 'GET /api/user/{id}/analytics': {
				// Ported from AnalyticsController.getUserAnalytics, but backed
				// by vibesdk-db-llm-usage instead of Cloudflare AI Gateway's
				// GraphQL Analytics API (no AWS equivalent exists) -- see that
				// package's module comment for exactly what's tracked and what
				// isn't (no cache-hit data, since aws/llm-client has no cache).
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const targetUserId = event.pathParameters?.id;
				if (!targetUserId) return errorResponse('User ID is required', 400);
				if (targetUserId !== session.user.id) return errorResponse('Forbidden', 403);

				const days = parseAnalyticsDays(event);
				if (days === null) return errorResponse('days must be an integer between 1 and 365', 400);

				const analytics = await getUsage().getUserAnalytics(targetUserId, days);
				return successResponse(analytics);
			}

			case 'POST /api/agent': {
				// Ported from worker/api/controllers/agent/controller.ts's
				// startCodeGeneration -- reduced to the "general"/agentic path
				// only, matching GET /api/capabilities' declared feature set
				// (the "app" feature's phased/blueprint-streaming UX is
				// enabled: false on this backend; there is no equivalent
				// pre-generation blueprint stream to emit here). Session state
				// (aws/agent-runtime's AgentSessionState, same DynamoDB table)
				// is created here rather than left to WS $connect's
				// lazy-init, specifically so `query` is already populated by
				// the time the client's first `generate_all` message arrives
				// with no message body of its own -- see aws/agent-runtime/src/messages.ts's
				// generate_all case, which falls back to state.query.
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const body = parseJsonBody(event);
				const query = typeof body?.query === 'string' ? body.query.trim() : '';
				if (!query) return errorResponse('query is required', 400);
				if (query.length > 20_000) return errorResponse('Prompt too large', 400);

				const sessionId = randomUUID();
				const now = new Date().toISOString();
				await getDdb().send(
					new PutCommand({
						TableName: requireEnv('AGENT_SESSIONS_TABLE'),
						Item: {
							session_id: sessionId,
							lock_version: 0,
							user_id: session.user.id,
							project_name: query.slice(0, 80),
							query,
							should_be_generating: false,
							current_dev_state: 'IDLE',
							conversation_messages: [],
							pending_user_inputs: [],
							generated_files: {},
							created_at: now,
							updated_at: now,
							expires_at: Math.floor(Date.now() / 1000) + 4 * 60 * 60,
						},
					}),
				);

				const wsEndpoint = requireEnv('AGENT_WS_ENDPOINT');
				const websocketUrl = `${wsEndpoint}?sessionId=${encodeURIComponent(sessionId)}&userId=${encodeURIComponent(session.user.id)}`;
				return ndjsonResponse({
					agentId: sessionId,
					websocketUrl,
					behaviorType: 'agentic',
					projectType: 'general',
					template: { files: [] },
				});
			}

			case 'GET /api/agent/{id}/connect': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const agentId = event.pathParameters?.id;
				if (!agentId) return errorResponse('Agent ID is required', 400);
				if (!(await isSessionOwner(agentId, session.user.id))) return errorResponse('Forbidden', 403);

				const wsEndpoint = requireEnv('AGENT_WS_ENDPOINT');
				const websocketUrl = `${wsEndpoint}?sessionId=${encodeURIComponent(agentId)}&userId=${encodeURIComponent(session.user.id)}`;
				return successResponse({ agentId, websocketUrl });
			}

			case 'GET /api/agent/{id}/analytics': {
				// Ported from AnalyticsController.getAgentAnalytics -- "agent"
				// here means an aws/agent-runtime session id. Ownership is
				// enforced in-handler (see isSessionOwner) since agent sessions
				// have no dedicated db-* store the way apps/identity do.
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const agentId = event.pathParameters?.id;
				if (!agentId) return errorResponse('Agent ID is required', 400);
				if (!(await isSessionOwner(agentId, session.user.id))) return errorResponse('Forbidden', 403);

				const days = parseAnalyticsDays(event);
				if (days === null) return errorResponse('days must be an integer between 1 and 365', 400);

				const analytics = await getUsage().getSessionAnalytics(agentId, days);
				return successResponse(analytics);
			}

			case 'GET /api/stats': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const stats = await getAnalytics().getUserStats(session.user.id);
				return successResponse(stats);
			}

			case 'GET /api/stats/activity': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const activities = await getAnalytics().getUserActivityTimeline(session.user.id, 20);
				return successResponse({ activities });
			}

			case 'GET /api/user/credentials': {
				// Reports which harness auth branch this user is on -- never
				// the ciphertext itself, so this is safe to return unauthenticated-
				// adjacent detail once a session is confirmed.
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const record = await getCredentials().get(session.user.id);
				return successResponse({ authMode: record.authMode, updatedAt: record.updatedAt });
			}

			case 'PUT /api/user/credentials': {
				// Uploads a Claude Code OAuth credentials export (the
				// `claudeAiOauth` blob from `.credentials.json`, see
				// aws/agent-harness/src/credentials-client.ts) as this user's
				// harness auth, replacing the platform's workspace-scoped
				// Anthropic API key for their sessions. Encrypted here with
				// KMS before it ever reaches DynamoDB -- this Lambda's role has
				// kms:Encrypt only, never kms:Decrypt (see
				// aws/infra/user-credentials.tf), so once written this Lambda
				// itself can't read the plaintext back either.
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const body = parseJsonBody(event);
				const credentialsJson = body?.credentialsJson;
				if (typeof credentialsJson !== 'object' || credentialsJson === null || Array.isArray(credentialsJson)) {
					return errorResponse('credentialsJson must be the JSON object from a Claude Code .credentials.json export', 400);
				}
				if (!('claudeAiOauth' in credentialsJson)) {
					return errorResponse('credentialsJson is missing the expected claudeAiOauth field -- is this a Claude Code .credentials.json export?', 400);
				}

				const plaintext = Buffer.from(JSON.stringify(credentialsJson), 'utf-8');
				// KMS Encrypt's plaintext limit for a symmetric key is 4096
				// bytes -- a real .credentials.json export is well under this,
				// so hitting it means something other than a genuine export.
				if (plaintext.byteLength > 4096) {
					return errorResponse('credentialsJson is too large to be a valid .credentials.json export', 400);
				}

				const encrypted = await getKms().send(
					new EncryptCommand({ KeyId: requireEnv('USER_CREDENTIALS_KMS_KEY_ARN'), Plaintext: plaintext }),
				);
				if (!encrypted.CiphertextBlob) return errorResponse('Encryption failed', 500);

				await getCredentials().putEncryptedCredentials(session.user.id, Buffer.from(encrypted.CiphertextBlob).toString('base64'));
				return successResponse({ authMode: 'byo_credentials' });
			}

			case 'DELETE /api/user/credentials': {
				// Reverts to the platform-key path -- deletes the stored
				// ciphertext entirely (HarnessCredentialsStore.clear), not just
				// a flag flip.
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				await getCredentials().clear(session.user.id);
				return successResponse({ authMode: 'platform_key' });
			}

			case 'GET /api/user/providers': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				const providers = await getProviders().getUserProviders(session.user.id);
				return successResponse({ providers: providers.filter((p) => p.isActive) });
			}

			case 'GET /api/user/providers/{id}': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!providerId) return errorResponse('Provider ID is required', 400);
				const provider = await getProviders().getProvider(session.user.id, providerId);
				if (!provider) return errorResponse('Failed to get provider', 500);
				return successResponse({ provider });
			}

			// Disabled in the live product too -- see this file's module
			// comment. Matched here for API-contract parity, not revived.
			case 'POST /api/user/providers':
			case 'PUT /api/user/providers/{id}':
			case 'DELETE /api/user/providers/{id}':
				return errorResponse(PROVIDERS_DISABLED_MESSAGE, 503);

			case 'GET /api/model-configs': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const store = getModelConfigs();
				const stored = await store.getUserModelConfigs(session.user.id);
				const byAction = new Map(stored.map((c) => [c.agentActionName, c]));

				const configs: Record<string, unknown> = {};
				for (const action of Object.keys(AGENT_CONFIG) as AgentActionKey[]) {
					configs[action] = resolveModelConfig(byAction.get(action) ?? null, action);
				}

				return successResponse({
					configs,
					defaults: AGENT_CONFIG,
					message: 'Model configurations retrieved successfully',
				});
			}

			case 'GET /api/model-configs/{agentAction}': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!isAgentActionKey(agentAction)) return errorResponse('Invalid agent action name', 400);

				const stored = await getModelConfigs().getUserModelConfig(session.user.id, agentAction);
				const config = resolveModelConfig(stored, agentAction);

				return successResponse({
					config,
					defaultConfig: AGENT_CONFIG[agentAction],
					message: 'Model configuration retrieved successfully',
				});
			}

			case 'PUT /api/model-configs/{agentAction}': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!isAgentActionKey(agentAction)) return errorResponse('Invalid agent action name', 400);

				const body = parseJsonBody(event) ?? {};
				const modelName = typeof body.modelName === 'string' ? body.modelName : undefined;
				const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
				const temperature = typeof body.temperature === 'number' ? body.temperature : undefined;
				const reasoningEffort =
					body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high'
						? body.reasoningEffort
						: undefined;
				const fallbackModel = typeof body.fallbackModel === 'string' ? body.fallbackModel : undefined;

				if (!modelName) return errorResponse('Model name is required', 400);

				if (!validateModelAccessForEnvironment(modelName, process.env)) {
					const provider = modelName.split('/')[0];
					return errorResponse(
						`Model requires API key for provider '${provider}'. Please add your API key in the BYOK settings or contact your platform administrator.`,
						403,
					);
				}
				if (fallbackModel && !validateModelAccessForEnvironment(fallbackModel, process.env)) {
					const provider = fallbackModel.split('/')[0];
					return errorResponse(
						`Fallback model requires API key for provider '${provider}'. Please add your API key in the BYOK settings or contact your platform administrator.`,
						403,
					);
				}

				try {
					validateModel(agentAction, modelName, 'primary', 'throw');
					validateModel(agentAction, fallbackModel, 'fallback', 'throw');
				} catch (error) {
					return errorResponse(error instanceof Error ? error.message : 'Invalid model configuration', 400);
				}

				const updated = await getModelConfigs().upsertUserModelConfig(session.user.id, agentAction, {
					modelName,
					maxTokens,
					temperature,
					reasoningEffort,
					fallbackModel,
				});

				return successResponse({ config: updated, message: 'Model configuration updated successfully' });
			}

			case 'DELETE /api/model-configs/{agentAction}': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);
				if (!isAgentActionKey(agentAction)) return errorResponse('Invalid agent action name', 400);

				const deleted = await getModelConfigs().deleteUserModelConfig(session.user.id, agentAction);
				if (!deleted) return errorResponse('Configuration not found or already using defaults', 404);

				return successResponse({ message: 'Model configuration reset to default successfully' });
			}

			case 'POST /api/model-configs/reset-all': {
				const session = await getUser(event);
				if (!session) return errorResponse('Unauthorized', 401);

				const resetCount = await getModelConfigs().resetAllUserConfigs(session.user.id);
				return successResponse({ resetCount, message: `${resetCount} model configurations reset to defaults` });
			}

			default:
				return errorResponse('Not found', 404);
		}
	} catch {
		return errorResponse('Internal server error', 500);
	}
}
