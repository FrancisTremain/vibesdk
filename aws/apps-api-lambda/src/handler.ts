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
 * (disabled in the original too), and public-endpoint rate limiting
 * (`RateLimitService.enforcePublicAppsRateLimit` -- `aws/rate-limit`
 * exists but isn't wired into this handler yet).
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuthOrchestrator } from 'vibesdk-auth-orchestration';
import { AppStore } from 'vibesdk-db-apps';
import { toPublicAppListItem } from './public-app-dto';
import { parsePublicAppsQuery } from './public-apps-query';
import { errorResponse, successResponse } from './response';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

let cachedApps: AppStore | null = null;
let cachedAuth: AuthOrchestrator | null = null;
let ddbClientOverride: DynamoDBDocumentClient | null = null;

/** Test-only, mirrors aws/auth-api-lambda's setDdbClientForTests. */
export function setDdbClientForTests(client: DynamoDBDocumentClient | null): void {
	ddbClientOverride = client;
	cachedApps = null;
	cachedAuth = null;
}

function getDdb(): DynamoDBDocumentClient {
	return ddbClientOverride ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function getApps(): AppStore {
	if (cachedApps) return cachedApps;
	cachedApps = new AppStore(getDdb(), requireEnv('APPS_TABLE'));
	return cachedApps;
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
	const apps = getApps();
	const routeKey = event.routeKey;
	const appId = event.pathParameters?.id;

	try {
		switch (routeKey) {
			case 'GET /api/apps/public': {
				const session = await getUser(event);
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
