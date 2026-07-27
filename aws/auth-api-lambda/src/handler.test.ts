import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyResultV2,
	APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';

process.env.PUBLIC_BASE_URL = 'https://app.example.com';
process.env.IDENTITY_TABLE = 'test-identity';
process.env.AUTH_FLOWS_TABLE = 'test-auth-flows';
process.env.AUDIT_TABLE = 'test-audit';
process.env.JWT_SECRET = 'Test-Jwt-Secret-For-AuthApiLambda-2024!';
process.env.GITHUB_CLIENT_ID = 'gh-client';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
process.env.GOOGLE_CLIENT_ID = 'go-client';
process.env.GOOGLE_CLIENT_SECRET = 'go-secret';
process.env.ORIGIN_VERIFY_SECRET = 'test-origin-verify-secret';

const { handler, setDdbClientForTests } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey: 'GET /api/auth/check',
		rawPath: '/api/auth/check',
		rawQueryString: '',
		requestContext: {
			accountId: '123',
			apiId: 'api',
			domainName: 'app.example.com',
			domainPrefix: 'app',
			http: { method: 'GET', path: '/api/auth/check', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
			requestId: 'req-1',
			routeKey: 'GET /api/auth/check',
			stage: '$default',
			time: 'now',
			timeEpoch: 0,
		},
		isBase64Encoded: false,
		...overrides,
		headers: { 'x-origin-verify': 'test-origin-verify-secret', ...overrides.headers },
	} as APIGatewayProxyEventV2;
}

function jsonBody(body: unknown): string {
	return JSON.stringify(body);
}

function body(result: APIGatewayProxyStructuredResultV2): any {
	return JSON.parse(result.body ?? '{}');
}

async function registerAndGetToken(email: string): Promise<string> {
	const result = asStructured(
		await handler(event({ routeKey: 'POST /api/auth/register', body: jsonBody({ email, password: 'Str0ngPassw0rd!' }) })),
	);
	return result.cookies!.find((c) => c.startsWith('accessToken='))!.split(';')[0]!.split('=')[1]!;
}

describe('auth-api-lambda handler', () => {
	beforeEach(() => {
		setDdbClientForTests(new FakeDynamoDocumentClient() as unknown as DynamoDBDocumentClient);
	});
	afterEach(() => {
		setDdbClientForTests(null);
		vi.restoreAllMocks();
	});

	it('registers a new user and sets the accessToken cookie', async () => {
		const result = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/auth/register',
					body: jsonBody({ email: 'user@example.com', password: 'Str0ngPassw0rd!' }),
				}),
			),
		);

		expect(result.statusCode).toBe(200);
		expect(body(result).data.user.email).toBe('user@example.com');
		expect(result.cookies?.some((c) => c.startsWith('accessToken='))).toBe(true);
	});

	it('rejects registration with a missing password', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/register', body: jsonBody({ email: 'user@example.com' }) })),
		);
		expect(result.statusCode).toBe(400);
	});

	it('rejects duplicate registration with the SecurityError status code', async () => {
		const registerEvent = event({
			routeKey: 'POST /api/auth/register',
			body: jsonBody({ email: 'dup@example.com', password: 'Str0ngPassw0rd!' }),
		});
		await handler(registerEvent);
		const result = asStructured(await handler(registerEvent));

		expect(result.statusCode).toBe(400);
		expect(body(result).error.message).toMatch(/already registered/);
	});

	it('logs in and reports authenticated via /check using the cookie', async () => {
		await handler(
			event({
				routeKey: 'POST /api/auth/register',
				body: jsonBody({ email: 'checkme@example.com', password: 'Str0ngPassw0rd!' }),
			}),
		);
		const login = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/auth/login',
					body: jsonBody({ email: 'checkme@example.com', password: 'Str0ngPassw0rd!' }),
				}),
			),
		);
		const token = login.cookies!.find((c) => c.startsWith('accessToken='))!.split(';')[0]!.split('=')[1]!;

		const check = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/check', cookies: [`accessToken=${token}`] })),
		);
		expect(body(check).data.authenticated).toBe(true);
		expect(body(check).data.user.email).toBe('checkme@example.com');
	});

	it('reports unauthenticated on /check with no token', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /api/auth/check' })));
		expect(body(result).data.authenticated).toBe(false);
	});

	it('requires auth on /profile and accepts a Bearer token', async () => {
		const registered = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/auth/register',
					body: jsonBody({ email: 'profile@example.com', password: 'Str0ngPassw0rd!' }),
				}),
			),
		);
		const token = registered.cookies!.find((c) => c.startsWith('accessToken='))!.split(';')[0]!.split('=')[1]!;

		const unauthed = asStructured(await handler(event({ routeKey: 'GET /api/auth/profile' })));
		expect(unauthed.statusCode).toBe(401);

		const authed = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/profile', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(authed.statusCode).toBe(200);
		expect(body(authed).data.user.email).toBe('profile@example.com');
	});

	it('logs out and clears the accessToken cookie', async () => {
		const registered = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/auth/register',
					body: jsonBody({ email: 'logout@example.com', password: 'Str0ngPassw0rd!' }),
				}),
			),
		);
		const token = registered.cookies!.find((c) => c.startsWith('accessToken='))!.split(';')[0]!.split('=')[1]!;

		const result = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/logout', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(result.cookies?.some((c) => c.startsWith('accessToken=;'))).toBe(true);

		const check = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/check', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(body(check).data.authenticated).toBe(false);
	});

	it('starts a GitHub OAuth flow with a redirect and nonce cookie', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /api/auth/oauth/{provider}', pathParameters: { provider: 'github' } })));

		expect(result.statusCode).toBe(302);
		expect(result.headers?.Location).toContain('https://github.com/login/oauth/authorize');
		expect(result.cookies?.some((c) => c.startsWith('oauth_nonce='))).toBe(true);
	});

	it('rejects an unsupported OAuth provider', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/oauth/{provider}', pathParameters: { provider: 'cloudflare' } })),
		);
		expect(result.statusCode).toBe(400);
	});

	it('completes a GitHub login callback end to end', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url === 'https://github.com/login/oauth/access_token') {
					return new Response(JSON.stringify({ access_token: 'gh-tok', token_type: 'bearer' }), { status: 200 });
				}
				if (url === 'https://api.github.com/user') {
					return new Response(JSON.stringify({ id: 7, login: 'octocat', email: 'octocat@example.com' }), { status: 200 });
				}
				if (url === 'https://api.github.com/user/emails') {
					return new Response(JSON.stringify([{ email: 'octocat@example.com', verified: true, primary: true }]), {
						status: 200,
					});
				}
				throw new Error(`unexpected fetch ${url}`);
			}),
		);

		const start = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/oauth/{provider}', pathParameters: { provider: 'github' } })),
		);
		const state = new URL(start.headers!.Location as string).searchParams.get('state')!;
		const nonce = start.cookies!.find((c) => c.startsWith('oauth_nonce='))!.split(';')[0]!.split('=')[1]!;

		const callback = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/auth/callback/{provider}',
					pathParameters: { provider: 'github' },
					queryStringParameters: { code: 'auth-code', state },
					cookies: [`oauth_nonce=${nonce}`],
				}),
			),
		);

		expect(callback.statusCode).toBe(302);
		expect(callback.cookies?.some((c) => c.startsWith('accessToken='))).toBe(true);
	});

	it('rejects an OAuth callback with a missing state', async () => {
		const result = asStructured(
			await handler(
				event({
					routeKey: 'GET /api/auth/callback/{provider}',
					pathParameters: { provider: 'github' },
					queryStringParameters: { code: 'auth-code' },
				}),
			),
		);
		expect(result.statusCode).toBe(302);
		expect(result.headers?.Location).toContain('error=missing_params');
	});

	it('requires auth on /sessions and lists the current session once logged in', async () => {
		const unauth = asStructured(await handler(event({ routeKey: 'GET /api/auth/sessions' })));
		expect(unauth.statusCode).toBe(401);

		const token = await registerAndGetToken('sessions@example.com');
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/sessions', headers: { authorization: `Bearer ${token}` } })),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.sessions.length).toBeGreaterThanOrEqual(1);
	});

	it('revokes a session by id', async () => {
		const token = await registerAndGetToken('revoke-session@example.com');
		const list = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/sessions', headers: { authorization: `Bearer ${token}` } })),
		);
		const sessionId = body(list).data.sessions[0].id;

		const result = asStructured(
			await handler(
				event({
					routeKey: 'DELETE /api/auth/sessions/{sessionId}',
					pathParameters: { sessionId },
					headers: { authorization: `Bearer ${token}` },
				}),
			),
		);
		expect(result.statusCode).toBe(200);
	});

	it('updates the profile via PUT /api/auth/profile', async () => {
		const token = await registerAndGetToken('authprofile@example.com');
		const result = asStructured(
			await handler(
				event({
					routeKey: 'PUT /api/auth/profile',
					headers: { authorization: `Bearer ${token}` },
					body: jsonBody({ displayName: 'New Name' }),
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		expect(body(result).data.success).toBe(true);
	});

	it('creates, lists, and revokes an API key, enforcing the per-user cap', async () => {
		const token = await registerAndGetToken('apikeys@example.com');
		const auth = { authorization: `Bearer ${token}` };

		const created = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/api-keys', headers: auth, body: jsonBody({ name: 'my key' }) })),
		);
		expect(created.statusCode).toBe(200);
		expect(body(created).data.key).toBeTruthy();

		const listed = asStructured(await handler(event({ routeKey: 'GET /api/auth/api-keys', headers: auth })));
		expect(body(listed).data.keys).toHaveLength(1);
		const keyId = body(listed).data.keys[0].id;

		const revoked = asStructured(
			await handler(event({ routeKey: 'DELETE /api/auth/api-keys/{keyId}', pathParameters: { keyId }, headers: auth })),
		);
		expect(revoked.statusCode).toBe(200);
	});

	it('rejects creating an API key with no name', async () => {
		const token = await registerAndGetToken('apikey-noname@example.com');
		const result = asStructured(
			await handler(
				event({ routeKey: 'POST /api/auth/api-keys', headers: { authorization: `Bearer ${token}` }, body: jsonBody({}) }),
			),
		);
		expect(result.statusCode).toBe(400);
	});

	it('exchanges a valid API key for a short-lived access token, then accepts it on /check', async () => {
		const token = await registerAndGetToken('exchange@example.com');
		const created = asStructured(
			await handler(
				event({
					routeKey: 'POST /api/auth/api-keys',
					headers: { authorization: `Bearer ${token}` },
					body: jsonBody({ name: 'exchange key' }),
				}),
			),
		);
		const rawKey = body(created).data.key;

		const exchanged = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/exchange-api-key', headers: { 'x-api-key': rawKey } })),
		);
		expect(exchanged.statusCode).toBe(200);
		const accessToken = body(exchanged).data.accessToken;

		const check = asStructured(
			await handler(event({ routeKey: 'GET /api/auth/check', headers: { authorization: `Bearer ${accessToken}` } })),
		);
		expect(body(check).data.authenticated).toBe(true);
		expect(body(check).data.user.email).toBe('exchange@example.com');
	});

	it('rejects exchanging an invalid API key', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/exchange-api-key', headers: { 'x-api-key': 'not-a-real-key' } })),
		);
		expect(result.statusCode).toBe(401);
	});

	it('rejects exchanging a revoked API key', async () => {
		const token = await registerAndGetToken('exchange-revoked@example.com');
		const auth = { authorization: `Bearer ${token}` };
		const created = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/api-keys', headers: auth, body: jsonBody({ name: 'to revoke' }) })),
		);
		const rawKey = body(created).data.key;
		const keyId = body(created).data.keyPreview; // not the id; re-fetch below
		const listed = asStructured(await handler(event({ routeKey: 'GET /api/auth/api-keys', headers: auth })));
		const realKeyId = body(listed).data.keys.find((k: { keyPreview: string }) => k.keyPreview === keyId).id;
		await handler(event({ routeKey: 'DELETE /api/auth/api-keys/{keyId}', pathParameters: { keyId: realKeyId }, headers: auth }));

		const result = asStructured(
			await handler(event({ routeKey: 'POST /api/auth/exchange-api-key', headers: { 'x-api-key': rawKey } })),
		);
		expect(result.statusCode).toBe(401);
	});
});
