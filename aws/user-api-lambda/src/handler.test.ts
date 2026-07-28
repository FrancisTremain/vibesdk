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
process.env.LLM_USAGE_TABLE = 'test-llm-usage';
process.env.AGENT_SESSIONS_TABLE = 'test-agent-sessions';
process.env.JWT_SECRET = 'Test-Jwt-Secret-For-UserApiLambda-2024!';
process.env.ORIGIN_VERIFY_SECRET = 'test-origin-verify-secret';

const { handler, setDdbClientForTests } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	// http.method is derived from routeKey (not hardcoded), so checkCsrf
	// (which reads requestContext.http.method) sees the right method for
	// whatever route a test is actually exercising.
	const routeKey = overrides.routeKey ?? 'GET /api/stats';
	const method = routeKey.split(' ')[0] ?? 'GET';
	return {
		version: '2.0',
		routeKey: 'GET /api/stats',
		rawPath: '/api/stats',
		rawQueryString: '',
		requestContext: {
			accountId: '123',
			apiId: 'api',
			domainName: 'app.example.com',
			domainPrefix: 'app',
			http: { method, path: '/api/stats', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
			requestId: 'req-1',
			routeKey: 'GET /api/stats',
			stage: '$default',
			time: 'now',
			timeEpoch: 0,
		},
		isBase64Encoded: false,
		...overrides,
		headers: { 'x-origin-verify': 'test-origin-verify-secret', 'x-csrf-token': 'test-csrf-token', ...overrides.headers },
		cookies: overrides.cookies ?? [`csrf-token=${encodeURIComponent(JSON.stringify({ token: 'test-csrf-token', timestamp: Date.now() }))}`],
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

	it('requires auth for /api/user/apps', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /api/user/apps' })));
		expect(result.statusCode).toBe(401);
	});

	it("lists a user's own apps with pagination", async () => {
		const { token, userId } = await registerUser(ddb, 'userapps@example.com');
		const { AppStore } = await import('vibesdk-db-apps');
		const apps = new AppStore(ddb as unknown as DynamoDBDocumentClient, 'test-apps');
		await apps.createApp({
			title: 'My App',
			description: null,
			iconUrl: null,
			originalPrompt: 'build me a thing',
			finalPrompt: null,
			framework: 'react',
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
			await handler(event({ routeKey: 'GET /api/user/apps', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.apps).toHaveLength(1);
		expect(body(result).data.apps[0].title).toBe('My App');
		expect(body(result).data.pagination.total).toBe(1);
	});

	it('requires auth for profile updates', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'PUT /api/user/profile', body: JSON.stringify({ displayName: 'New Name' }) })),
		);
		expect(result.statusCode).toBe(401);
	});

	it('updates displayName and bio for the authenticated user', async () => {
		const { token } = await registerUser(ddb, 'profile@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/user/profile',
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ displayName: 'New Name', bio: 'Hello there' }),
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.success).toBe(true);
	});

	it('rejects an invalid username on profile update', async () => {
		const { token } = await registerUser(ddb, 'badusername@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/user/profile',
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ username: 'a' }),
				}),
			),
		);
		expect(result.statusCode).toBe(400);
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

describe('model-config routes', () => {
	let ddb: FakeDynamoDocumentClient;

	beforeEach(() => {
		JWTUtils.resetInstanceForTests();
		ddb = new FakeDynamoDocumentClient();
		setDdbClientForTests(ddb as unknown as DynamoDBDocumentClient);
		process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-platform-key-1234567890';
	});
	afterEach(() => {
		setDdbClientForTests(null);
		delete process.env.GOOGLE_AI_STUDIO_API_KEY;
	});

	it('lists all agent-action configs, defaulted, for a fresh user', async () => {
		const { token } = await registerUser(ddb, 'mc-list@example.com');
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/model-configs', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.configs.blueprint.isUserOverride).toBe(false);
	});

	it('rejects an invalid agent action name', async () => {
		const { token } = await registerUser(ddb, 'mc-invalid@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'not-a-real-action' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(400);
	});

	it('updates and then reads back a model config for an allowed model', async () => {
		const { token } = await registerUser(ddb, 'mc-update@example.com');

		const update = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'templateSelection' },
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ modelName: 'google-ai-studio/gemini-2.5-flash-lite' }),
				}),
			),
		);
		expect(update.statusCode).toBe(200);

		const fetched = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'templateSelection' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(body(fetched).data.config.isUserOverride).toBe(true);
		expect(body(fetched).data.config.name).toBe('google-ai-studio/gemini-2.5-flash-lite');
	});

	it("rejects a model that violates the agent action's constraint", async () => {
		const { token } = await registerUser(ddb, 'mc-constraint@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'templateSelection' },
					headers: { authorization: `Bearer ${token}` },
					// A LARGE model, not allowed for templateSelection (constrained to lite models).
					body: JSON.stringify({ modelName: 'google-ai-studio/gemini-2.5-pro' }),
				}),
			),
		);
		expect(result.statusCode).toBe(400);
	});

	it('rejects a model whose provider has no platform key configured', async () => {
		const { token } = await registerUser(ddb, 'mc-no-key@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'deepDebugger' },
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ modelName: 'anthropic/claude-sonnet-4-5' }),
				}),
			),
		);
		expect(result.statusCode).toBe(403);
	});

	it('deletes a config back to defaults, then 404s on a second delete', async () => {
		const { token } = await registerUser(ddb, 'mc-delete@example.com');
		await handler(
			event({
				routeKey: 'PUT /api/model-configs/{agentAction}',
				pathParameters: { agentAction: 'templateSelection' },
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ modelName: 'google-ai-studio/gemini-2.5-flash-lite' }),
			}),
		);

		const first = asStructured(
			await handler(
				event({
					routeKey: 'DELETE /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'templateSelection' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(first.statusCode).toBe(200);

		const second = asStructured(
			await handler(
				event({
					routeKey: 'DELETE /api/model-configs/{agentAction}',
					pathParameters: { agentAction: 'templateSelection' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(second.statusCode).toBe(404);
	});

	it('resets all configs and reports the count', async () => {
		const { token } = await registerUser(ddb, 'mc-reset@example.com');
		await handler(
			event({
				routeKey: 'PUT /api/model-configs/{agentAction}',
				pathParameters: { agentAction: 'templateSelection' },
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ modelName: 'google-ai-studio/gemini-2.5-flash-lite' }),
			}),
		);

		const result = asStructured(
			await handler(event({ routeKey: 'POST /api/model-configs/reset-all', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.resetCount).toBe(1);
	});

	it('requires auth for /api/user/{id}/analytics', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/user/{id}/analytics', pathParameters: { id: 'someone' } })),
		);
		expect(result.statusCode).toBe(401);
	});

	it("rejects reading another user's analytics", async () => {
		const { token } = await registerUser(ddb, 'ua-owner@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/user/{id}/analytics',
					pathParameters: { id: 'not-me' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(403);
	});

	it('rejects an out-of-range days parameter for /api/user/{id}/analytics', async () => {
		const { token, userId } = await registerUser(ddb, 'ua-days@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/user/{id}/analytics',
					pathParameters: { id: userId },
					rawQueryString: 'days=400',
					queryStringParameters: { days: '400' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(400);
	});

	it('returns zeroed usage analytics for a user with no recorded LLM calls', async () => {
		const { token, userId } = await registerUser(ddb, 'ua-zero@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/user/{id}/analytics',
					pathParameters: { id: userId },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data).toMatchObject({ userId, totalRequests: 0, errorRate: 0, lastRequestAt: null });
	});

	it('aggregates recorded LLM usage for a user', async () => {
		const { token, userId } = await registerUser(ddb, 'ua-agg@example.com');
		const { UsageStore } = await import('vibesdk-db-llm-usage');
		const usage = new UsageStore(ddb as unknown as ConstructorParameters<typeof UsageStore>[0], 'test-llm-usage');
		await usage.recordUsage({
			userId,
			sessionId: 'session-1',
			provider: 'anthropic',
			model: 'anthropic/claude-sonnet-4-5',
			tokensIn: 100,
			tokensOut: 50,
			error: false,
		});

		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/user/{id}/analytics',
					pathParameters: { id: userId },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data).toMatchObject({ userId, totalRequests: 1, tokensIn: 100, tokensOut: 50 });
	});

	it('requires auth for /api/agent/{id}/analytics', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/agent/{id}/analytics', pathParameters: { id: 'session-1' } })),
		);
		expect(result.statusCode).toBe(401);
	});

	it("rejects reading another user's agent session analytics", async () => {
		const { token } = await registerUser(ddb, 'aa-owner@example.com');
		ddb.seed({ session_id: 'someone-elses-session', user_id: 'a-different-user' });

		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/agent/{id}/analytics',
					pathParameters: { id: 'someone-elses-session' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(403);
	});

	it('returns 403 for an agent session that does not exist', async () => {
		const { token } = await registerUser(ddb, 'aa-missing@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/agent/{id}/analytics',
					pathParameters: { id: 'nonexistent-session' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(403);
	});

	it('returns usage analytics for a session the user owns', async () => {
		const { token, userId } = await registerUser(ddb, 'aa-owned@example.com');
		ddb.seed({ session_id: 'my-session', user_id: userId });
		const { UsageStore } = await import('vibesdk-db-llm-usage');
		const usage = new UsageStore(ddb as unknown as ConstructorParameters<typeof UsageStore>[0], 'test-llm-usage');
		await usage.recordUsage({
			userId,
			sessionId: 'my-session',
			provider: 'anthropic',
			model: 'anthropic/claude-sonnet-4-5',
			tokensIn: 10,
			tokensOut: 20,
			error: true,
		});

		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/agent/{id}/analytics',
					pathParameters: { id: 'my-session' },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data).toMatchObject({ sessionId: 'my-session', totalRequests: 1, erroredRequests: 1, errorRate: 1 });
	});

	it('rejects a cookie-authenticated mutation with no CSRF cookie/header', async () => {
		const { token } = await registerUser(ddb, 'csrf-cookie@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/user/profile',
					headers: { 'x-csrf-token': undefined as unknown as string },
					cookies: [`accessToken=${encodeURIComponent(token)}`],
					body: JSON.stringify({ displayName: 'No CSRF' }),
				}),
			),
		);
		expect(result.statusCode).toBe(403);
	});

	it('allows a bearer-authenticated mutation even without a CSRF pair', async () => {
		const { token } = await registerUser(ddb, 'csrf-bearer@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/user/profile',
					headers: { authorization: `Bearer ${token}`, 'x-csrf-token': undefined as unknown as string },
					cookies: [],
					body: JSON.stringify({ displayName: 'Bearer OK' }),
				}),
			),
		);
		expect(result.statusCode).toBe(200);
	});
});
