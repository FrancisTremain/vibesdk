import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubExporterOAuthProvider } from './github-exporter';

function createProvider() {
	return new GitHubExporterOAuthProvider('client-id', 'client-secret', 'https://app.local/api/github/oauth/callback');
}

describe('GitHubExporterOAuthProvider', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('requests repo scopes in the authorization URL, not just sign-in scopes', async () => {
		const url = await createProvider().getAuthorizationUrl('state-value');
		const params = new URL(url).searchParams;
		expect(params.get('scope')).toBe('public_repo repo');
	});

	it('does not verify email via /user/emails -- uses /user directly', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url === 'https://api.github.com/user') {
				return new Response(JSON.stringify({ id: 42, login: 'octocat', name: 'Octo Cat' }), { status: 200 });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const info = await createProvider().getUserInfo('token');

		expect(info).toEqual({
			id: '42',
			email: 'octocat@github.local',
			name: 'Octo Cat',
			picture: undefined,
			emailVerified: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('throws when /user fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
		await expect(createProvider().getUserInfo('bad-token')).rejects.toThrow(/Failed to retrieve user information/);
	});
});
