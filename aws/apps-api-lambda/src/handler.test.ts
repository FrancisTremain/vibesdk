import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyResultV2,
	APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { JWTUtils } from 'vibesdk-auth-orchestration';

process.env.APPS_TABLE = 'test-apps';
process.env.IDENTITY_TABLE = 'test-identity';
process.env.AUTH_FLOWS_TABLE = 'test-auth-flows';
process.env.JWT_SECRET = 'Test-Jwt-Secret-For-AppsApiLambda-2024!';

const { handler, setDdbClientForTests } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey: 'GET /api/apps/public',
		rawPath: '/api/apps/public',
		rawQueryString: '',
		headers: {},
		requestContext: {
			accountId: '123',
			apiId: 'api',
			domainName: 'app.example.com',
			domainPrefix: 'app',
			http: { method: 'GET', path: '/api/apps/public', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
			requestId: 'req-1',
			routeKey: 'GET /api/apps/public',
			stage: '$default',
			time: 'now',
			timeEpoch: 0,
		},
		isBase64Encoded: false,
		...overrides,
	} as APIGatewayProxyEventV2;
}

function body(result: APIGatewayProxyStructuredResultV2): any {
	return JSON.parse(result.body ?? '{}');
}

async function registerUser(ddb: FakeDynamoDocumentClient, email: string): Promise<{ token: string; userId: string }> {
	// Uses the real AuthOrchestrator (via a dynamic import to share the
	// singleton JWTUtils instance) to create a user and a valid access
	// token against the same fake table, exactly as aws/auth-api-lambda
	// would have already done for a real request.
	const { AuthOrchestrator } = await import('vibesdk-auth-orchestration');
	const auth = new AuthOrchestrator({
		ddb: ddb as unknown as DynamoDBDocumentClient,
		identityTable: 'test-identity',
		authFlowsTable: 'test-auth-flows',
		jwtSecret: 'Test-Jwt-Secret-For-AppsApiLambda-2024!',
	});
	const result = await auth.register({ email, password: 'Str0ngPassw0rd!' }, new Request('https://app.example.com'));
	return { token: result.accessToken, userId: result.user.id };
}

describe('apps-api-lambda handler', () => {
	let ddb: FakeDynamoDocumentClient;

	beforeEach(() => {
		JWTUtils.resetInstanceForTests();
		ddb = new FakeDynamoDocumentClient();
		setDdbClientForTests(ddb as unknown as DynamoDBDocumentClient);
	});
	afterEach(() => {
		setDdbClientForTests(null);
	});

	it('lists public apps with no auth required', async () => {
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		await apps.createApp({
			title: 'Public App',
			description: null,
			iconUrl: null,
			originalPrompt: 'build me a thing',
			finalPrompt: null,
			framework: 'react',
			userId: 'owner-1',
			sessionToken: null,
			visibility: 'public',
			status: 'completed',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 1,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});

		const result = asStructured(await handler(event({ routeKey: 'GET /api/apps/public' })));
		expect(result.statusCode).toBe(200);
		expect(body(result).data.apps).toHaveLength(1);
		expect(body(result).data.apps[0].title).toBe('Public App');
	});

	it('rejects an out-of-range page in the public listing', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/apps/public', queryStringParameters: { page: '999' } })),
		);
		expect(result.statusCode).toBe(400);
	});

	it('requires auth for the personal apps list', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /api/apps' })));
		expect(result.statusCode).toBe(401);
	});

	it("lists a user's own apps once authenticated", async () => {
		const { token, userId } = await registerUser(ddb, 'owner@example.com');
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		await apps.createApp({
			title: 'My App',
			description: null,
			iconUrl: null,
			originalPrompt: 'x',
			finalPrompt: null,
			framework: null,
			userId,
			sessionToken: null,
			visibility: 'private',
			status: 'completed',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 1,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});

		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/apps', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.apps).toHaveLength(1);
	});

	it('hides a private app from a non-owner and 404s', async () => {
		const owner = await registerUser(ddb, 'priv-owner@example.com');
		const other = await registerUser(ddb, 'other@example.com');
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		const created = await apps.createApp({
			title: 'Private App',
			description: null,
			iconUrl: null,
			originalPrompt: 'x',
			finalPrompt: null,
			framework: null,
			userId: owner.userId,
			sessionToken: null,
			visibility: 'private',
			status: 'completed',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 1,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});

		const asOther = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/apps/{id}',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${other.token}` },
				}),
			),
		);
		expect(asOther.statusCode).toBe(404);

		const asOwner = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/apps/{id}',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${owner.token}` },
				}),
			),
		);
		expect(asOwner.statusCode).toBe(200);
		expect(body(asOwner).data.app.title).toBe('Private App');
	});

	it('toggles favorite and star, and rejects updating visibility for a non-owner', async () => {
		const owner = await registerUser(ddb, 'fav-owner@example.com');
		const other = await registerUser(ddb, 'fav-other@example.com');
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		const created = await apps.createApp({
			title: 'Shared App',
			description: null,
			iconUrl: null,
			originalPrompt: 'x',
			finalPrompt: null,
			framework: null,
			userId: owner.userId,
			sessionToken: null,
			visibility: 'public',
			status: 'completed',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 1,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});

		const favResult = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/apps/{id}/favorite',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${other.token}` },
				}),
			),
		);
		expect(favResult.statusCode).toBe(200);
		expect(body(favResult).data.isFavorite).toBe(true);

		const starResult = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/apps/{id}/star',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${other.token}` },
				}),
			),
		);
		expect(starResult.statusCode).toBe(200);
		expect(body(starResult).data.isStarred).toBe(true);

		const visibilityResult = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/apps/{id}/visibility',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${other.token}` },
					body: JSON.stringify({ visibility: 'private' }),
				}),
			),
		);
		expect(visibilityResult.statusCode).toBe(403);
	});

	it('deletes an app for its owner and 404s afterward', async () => {
		const owner = await registerUser(ddb, 'del-owner@example.com');
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		const created = await apps.createApp({
			title: 'Deletable App',
			description: null,
			iconUrl: null,
			originalPrompt: 'x',
			finalPrompt: null,
			framework: null,
			userId: owner.userId,
			sessionToken: null,
			visibility: 'public',
			status: 'completed',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 1,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});

		const deleteResult = asStructured(
			await handler(
				event({
					routeKey: 'DELETE /api/apps/{id}',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${owner.token}` },
				}),
			),
		);
		expect(deleteResult.statusCode).toBe(200);

		const getResult = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/apps/{id}',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${owner.token}` },
				}),
			),
		);
		expect(getResult.statusCode).toBe(404);
	});
});
