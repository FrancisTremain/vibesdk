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
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuthOrchestrator } from 'vibesdk-auth-orchestration';
import { AnalyticsStore } from 'vibesdk-db-analytics';
import { AppStore, type UserAppQueryOptions } from 'vibesdk-db-apps';
import { UserStore } from 'vibesdk-db-identity';
import { ModelConfigStore, ModelProviderStore } from 'vibesdk-db-model-config';
import {
	AGENT_CONFIG,
	resolveModelConfig,
	validateModel,
	validateModelAccessForEnvironment,
	type AgentActionKey,
} from 'vibesdk-model-config-defaults';
import { errorResponse, successResponse } from './response';

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
let ddbClientOverride: DynamoDBDocumentClient | null = null;

/** Test-only, mirrors the sibling Lambda packages' setDdbClientForTests. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedAnalytics = null;
	cachedProviders = null;
	cachedModelConfigs = null;
	cachedAuth = null;
	cachedApps = null;
	cachedUsers = null;
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
