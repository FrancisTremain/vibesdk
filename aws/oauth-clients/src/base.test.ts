import { describe, it, expect, vi, afterEach } from 'vitest';
import { BaseOAuthProvider, type OAuthTokens } from './base';
import type { OAuthUserInfo } from './types';

class TestProvider extends BaseOAuthProvider {
	protected readonly provider = 'test';
	protected readonly authorizationUrl = 'https://provider.example/authorize';
	protected readonly tokenUrl = 'https://provider.example/token';
	protected readonly userInfoUrl = 'https://provider.example/userinfo';
	protected readonly scopes = ['read', 'write'];

	async getUserInfo(): Promise<OAuthUserInfo> {
		return { id: '1', email: 'user@example.com' };
	}

	async exchange(code: string): Promise<OAuthTokens> {
		return this.exchangeCodeForTokens(code);
	}
}

describe('BaseOAuthProvider', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('builds an authorization URL with the configured scopes', async () => {
		const provider = new TestProvider('client-id', 'secret', 'https://app.local/callback');
		const url = await provider.getAuthorizationUrl('state-123');

		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe('https://provider.example/authorize');
		expect(parsed.searchParams.get('client_id')).toBe('client-id');
		expect(parsed.searchParams.get('scope')).toBe('read write');
		expect(parsed.searchParams.get('state')).toBe('state-123');
		expect(parsed.searchParams.has('code_challenge')).toBe(false);
	});

	it('adds a PKCE challenge when a code verifier is supplied', async () => {
		const provider = new TestProvider('client-id', 'secret', 'https://app.local/callback');
		const url = await provider.getAuthorizationUrl('state-123', 'verifier-abc');

		const parsed = new URL(url);
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
		expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
	});

	it('exchanges a code for tokens', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
					{ status: 200 },
				),
			),
		);

		const provider = new TestProvider('client-id', 'secret', 'https://app.local/callback');
		const tokens = await provider.exchange('auth-code');

		expect(tokens).toEqual({
			accessToken: 'at',
			refreshToken: 'rt',
			expiresIn: 3600,
			tokenType: 'Bearer',
		});
	});

	it('throws when the token endpoint returns an error', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));

		const provider = new TestProvider('client-id', 'secret', 'https://app.local/callback');
		await expect(provider.exchange('auth-code')).rejects.toThrow(/Token exchange failed/);
	});

	it('generates distinct, charset-valid PKCE code verifiers', () => {
		const first = BaseOAuthProvider.generateCodeVerifier();
		const second = BaseOAuthProvider.generateCodeVerifier();

		expect(first).toHaveLength(64);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9\-._~]+$/);
	});
});
