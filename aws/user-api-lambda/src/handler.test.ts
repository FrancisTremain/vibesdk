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
process.env.MODEL_CONFIG_TABLE = 'test-model-config';
process.env.IDENTITY_TABLE = 'test-identity';
process.env.AUTH_FLOWS_TABLE = 'test-auth-flows';
process.env.JWT_SECRET = 'Test-Jwt-Secret-For-UserApiLambda-2024!';

const { handler, setDdbClientForTests } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey: 'GET /api/stats',
		rawPath: '/api/stats',
		rawQueryString: '',
		headers: {},
		requestContext: {
			accountId: '123',
			apiId: 'api',
			domainName: 'app.example.com',
			domainPrefix: 'app',
			http: { method: 'GET', path: '/api/stats', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
			requestId: 'req-1',
			routeKey: 'GET /api/stats',
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
	const { AuthOrchestrator } = await import('vibesdk-auth-orchestration');
	const auth = new AuthOrchestrator({
		ddb: ddb as unknown as DynamoDBDocumentClient,
		identityTable: 'test-identity',
		authFlowsTable: 'test-auth-flows',
		jwtSecret: 'Test-Jwt-Secret-For-UserApiLambda-2024!',
	});
	const result = await auth.register({ email, password: 'Str0ngPassw0rd!' }, new Request('https://app.example.com'));
	return { token: result.accessToken, userId: result.user.id };
}

describe('user-api-lambda handler', () => {
	let ddb: FakeDynamoDocumentClient;

	beforeEach(() => {
		JWTUtils.resetInstanceForTests();
		ddb = new FakeDynamoDocumentClient();
		setDdbClientForTests(ddb as unknown as DynamoDBDocumentClient);
	});
	afterEach(() => {
		setDdbClientForTests(null);
	});

	it('requires auth for /stats', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /api/stats' })));
		expect(result.statusCode).toBe(401);
	});

	it('returns zeroed stats for a fresh user', async () => {
		const { token } = await registerUser(ddb, 'stats@example.com');
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/stats', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.appCount).toBe(0);
	});

	it('returns an empty activity timeline for a fresh user', async () => {
		const { token } = await registerUser(ddb, 'activity@example.com');
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/stats/activity', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.activities).toEqual([]);
	});

	it('lists only active custom providers', async () => {
		const { token, userId } = await registerUser(ddb, 'provider@example.com');
		const { ModelProviderStore } = await import('vibesdk-db-model-config');
		const providers = new ModelProviderStore(ddb as unknown as DynamoDBDocumentClient, 'test-model-config');
		await providers.createProvider(userId, { name: 'active-one', baseUrl: 'https://api.example.com', secretId: 'secret-1' });
		const inactive = await providers.createProvider(userId, { name: 'inactive-one', baseUrl: 'https://api2.example.com', secretId: 'secret-2' });
		await providers.updateProvider(userId, inactive.id, { isActive: false });

		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/user/providers', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.providers).toHaveLength(1);
		expect(body(result).data.providers[0].name).toBe('active-one');
	});

	it('gets a single provider by id', async () => {
		const { token, userId } = await registerUser(ddb, 'single-provider@example.com');
		const { ModelProviderStore } = await import('vibesdk-db-model-config');
		const providers = new ModelProviderStore(ddb as unknown as DynamoDBDocumentClient, 'test-model-config');
		const created = await providers.createProvider(userId, { name: 'my-provider', baseUrl: 'https://api.example.com', secretId: 'secret-1' });

		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/user/providers/{id}',
					pathParameters: { id: created.id },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.provider.name).toBe('my-provider');
	});

	it('rejects creating/updating/deleting providers with 503, matching the live product', async () => {
		const { token } = await registerUser(ddb, 'disabled@example.com');
		for (const routeKey of ['POST /api/user/providers', 'PUT /api/user/providers/{id}', 'DELETE /api/user/providers/{id}']) {
			const result = asStructured(
				await handler(event({ routeKey, pathParameters: { id: 'whatever' }, headers: { authorization: `Bearer ${token}` } })),
			);
			expect(result.statusCode).toBe(503);
		}
	});
});
