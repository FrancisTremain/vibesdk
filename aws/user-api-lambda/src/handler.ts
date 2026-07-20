/**
 * API Gateway HTTP API (v2) Lambda handler for user stats
 * (worker/api/routes/statsRoutes.ts, worker/api/controllers/stats/
 * controller.ts) and custom model-provider listing
 * (worker/api/routes/modelProviderRoutes.ts,
 * worker/api/controllers/modelProviders/controller.ts). Same
 * `event.routeKey`-switch shape as `aws/auth-api-lambda`/
 * `aws/apps-api-lambda`.
 *
 * Deliberately narrow -- see the README for the two real reasons this
 * package doesn't cover more of `worker/api/routes/modelConfigRoutes.ts`
 * or the mutating side of `modelProviderRoutes.ts`:
 *
 * 1. `worker/api/controllers/modelConfig/controller.ts` validates
 *    every `agentAction` against `AGENT_CONFIG`
 *    (`worker/agents/inferutils/config.ts`) and merges stored
 *    overrides with per-action defaults/constraints pulled from it --
 *    `aws/db-model-config`'s README documents this as explicitly not
 *    ported (storage only, no `AGENT_CONFIG` dependency). Porting the
 *    model-config CRUD routes faithfully would mean also porting or
 *    duplicating that large, product-specific static config -- a
 *    different, larger task than every other Lambda handler in this
 *    migration, not attempted here.
 * 2. `ModelProvidersController.createProvider`/`updateProvider`/
 *    `deleteProvider` are themselves disabled in the live product
 *    right now (`worker/api/controllers/modelProviders/controller.ts`
 *    returns 503 "Custom model providers are temporarily disabled" for
 *    all three, unconditionally, before touching the database). This
 *    handler mirrors that exact current behavior rather than reviving
 *    a disabled feature -- see the routes below.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuthOrchestrator } from 'vibesdk-auth-orchestration';
import { AnalyticsStore } from 'vibesdk-db-analytics';
import { ModelProviderStore } from 'vibesdk-db-model-config';
import { errorResponse, successResponse } from './response';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

let cachedAnalytics: AnalyticsStore | null = null;
let cachedProviders: ModelProviderStore | null = null;
let cachedAuth: AuthOrchestrator | null = null;
let ddbClientOverride: DynamoDBDocumentClient | null = null;

/** Test-only, mirrors the sibling Lambda packages' setDdbClientForTests. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedAnalytics = null;
	cachedProviders = null;
	cachedAuth = null;
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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const routeKey = event.routeKey;
	const providerId = event.pathParameters?.id;

	try {
		switch (routeKey) {
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

			default:
				return errorResponse('Not found', 404);
		}
	} catch {
		return errorResponse('Internal server error', 500);
	}
}
