import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

process.env.GITHUB_EXPORTER_CLIENT_ID = 'client-id';
process.env.GITHUB_EXPORTER_CLIENT_SECRET = 'client-secret';
process.env.JWT_SECRET = 'test-jwt-secret';

const createUserRepositoryMock = vi.fn();
const getRepositoryMock = vi.fn();
vi.mock('./github-repo-api', () => ({
	createUserRepository: (...args: unknown[]) => createUserRepositoryMock(...args),
	getRepository: (...args: unknown[]) => getRepositoryMock(...args),
}));

const pushSessionToGitHubMock = vi.fn();
vi.mock('./push', () => ({ pushSessionToGitHub: (...args: unknown[]) => pushSessionToGitHubMock(...args) }));

const exchangeCodeForTokensMock = vi.fn();
const getUserInfoMock = vi.fn();
vi.mock('vibesdk-oauth-clients', () => ({
	GitHubExporterOAuthProvider: class {
		async getAuthorizationUrl(state: string) {
			return `https://github.com/login/oauth/authorize?state=${state}`;
		}
		exchangeCodeForTokens(...args: unknown[]) {
			return exchangeCodeForTokensMock(...args);
		}
		getUserInfo(...args: unknown[]) {
			return getUserInfoMock(...args);
		}
	},
}));

const { handler } = await import('./handler');
const { signExportState } = await import('./state-token');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey: 'POST /api/github/export/initiate',
		rawPath: '',
		rawQueryString: '',
		headers: { host: 'api.example.com' },
		isBase64Encoded: false,
		requestContext: { domainName: 'api.example.com' } as APIGatewayProxyEventV2['requestContext'],
		...overrides,
	} as APIGatewayProxyEventV2;
}

beforeEach(() => {
	createUserRepositoryMock.mockReset();
	getRepositoryMock.mockReset();
	pushSessionToGitHubMock.mockReset();
	exchangeCodeForTokensMock.mockReset();
	getUserInfoMock.mockReset();
});

describe('POST /api/github/export/initiate', () => {
	it('returns a GitHub authorize URL for a valid request', async () => {
		const result = asStructured(
			await handler(
				event({
					body: JSON.stringify({ sessionId: 's1', repositoryName: 'my-app', returnUrl: 'https://app.local/chat' }),
				}),
			),
		);
		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body!) as { success: boolean; data: { authUrl: string } };
		expect(body.success).toBe(true);
		expect(body.data.authUrl).toContain('https://github.com/login/oauth/authorize?state=');
	});

	it('rejects a request missing repositoryName', async () => {
		const result = asStructured(
			await handler(event({ body: JSON.stringify({ sessionId: 's1', returnUrl: 'https://app.local/chat' }) })),
		);
		expect(result.statusCode).toBe(400);
	});
});

describe('GET /api/github/oauth/callback', () => {
	async function stateFor(overrides: Partial<Parameters<typeof signExportState>[0]> = {}) {
		return signExportState(
			{ sessionId: 's1', repositoryName: 'my-app', returnUrl: 'https://app.local/chat', ...overrides },
			'test-jwt-secret',
		);
	}

	it('redirects with an error when the state token is invalid', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/github/oauth/callback', queryStringParameters: { code: 'abc', state: 'garbage' } })),
		);
		expect(result.statusCode).toBe(302);
		expect(result.headers?.Location).toContain('reason=invalid_state');
	});

	it('redirects with an error when GitHub reports an OAuth error', async () => {
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/github/oauth/callback', queryStringParameters: { error: 'access_denied' } })),
		);
		expect(result.statusCode).toBe(302);
		expect(result.headers?.Location).toBe('https://api.example.com/chat?github_export=error&reason=access_denied');
	});

	it('creates the repo, pushes, and redirects to returnUrl on success', async () => {
		exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'gh-token' });
		getUserInfoMock.mockResolvedValue({ id: '1', email: 'octocat@github.local', name: 'octocat' });
		createUserRepositoryMock.mockResolvedValue({ success: true, repository: { html_url: 'https://github.com/octocat/my-app' } });
		pushSessionToGitHubMock.mockResolvedValue({ success: true, commitSha: 'abc123' });

		const state = await stateFor();
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/github/oauth/callback', queryStringParameters: { code: 'abc', state } })),
		);

		expect(pushSessionToGitHubMock).toHaveBeenCalledWith('s1', 'https://github.com/octocat/my-app', 'gh-token');
		expect(result.statusCode).toBe(302);
		expect(result.headers?.Location).toBe(
			'https://app.local/chat?github_export=success&repository_url=https%3A%2F%2Fgithub.com%2Foctocat%2Fmy-app',
		);
	});

	it('falls back to the existing repository when creation reports alreadyExists', async () => {
		exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'gh-token' });
		getUserInfoMock.mockResolvedValue({ id: '1', email: 'octocat@github.local', name: 'octocat' });
		createUserRepositoryMock.mockResolvedValue({ success: false, error: 'exists', alreadyExists: true, repositoryName: 'my-app' });
		getRepositoryMock.mockResolvedValue({ success: true, repository: { html_url: 'https://github.com/octocat/my-app' } });
		pushSessionToGitHubMock.mockResolvedValue({ success: true, commitSha: 'abc123' });

		const state = await stateFor();
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/github/oauth/callback', queryStringParameters: { code: 'abc', state } })),
		);

		expect(getRepositoryMock).toHaveBeenCalledWith({ owner: 'octocat', repo: 'my-app', token: 'gh-token' });
		expect(result.headers?.Location).toContain('github_export=success');
	});

	it('redirects with an error when the push fails', async () => {
		exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'gh-token' });
		getUserInfoMock.mockResolvedValue({ id: '1', email: 'octocat@github.local', name: 'octocat' });
		createUserRepositoryMock.mockResolvedValue({ success: true, repository: { html_url: 'https://github.com/octocat/my-app' } });
		pushSessionToGitHubMock.mockResolvedValue({ success: false, error: 'push rejected' });

		const state = await stateFor();
		const result = asStructured(
			await handler(event({ routeKey: 'GET /api/github/oauth/callback', queryStringParameters: { code: 'abc', state } })),
		);

		expect(result.headers?.Location).toContain('github_export=error');
		expect(result.headers?.Location).toContain('push%20rejected');
	});
});

describe('unknown route', () => {
	it('returns 404', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /nope' })));
		expect(result.statusCode).toBe(404);
	});
});
