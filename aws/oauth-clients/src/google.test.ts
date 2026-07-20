import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleOAuthProvider } from './google';

function createProvider() {
	return new GoogleOAuthProvider('client-id', 'client-secret', 'https://app.local/api/auth/callback/google');
}

describe('GoogleOAuthProvider.getUserInfo', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('maps the userinfo response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						id: '123',
						email: 'user@example.com',
						verified_email: true,
						name: 'Test User',
						picture: 'https://example.com/pic.jpg',
					}),
					{ status: 200 },
				),
			),
		);

		const info = await createProvider().getUserInfo('token');

		expect(info).toEqual({
			id: '123',
			email: 'user@example.com',
			name: 'Test User',
			picture: 'https://example.com/pic.jpg',
			emailVerified: true,
		});
	});

	it('throws when the userinfo request fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('unauthorized', { status: 401 })),
		);

		await expect(createProvider().getUserInfo('token')).rejects.toThrow(/Failed to get user info/);
	});
});

describe('GoogleOAuthProvider.create', () => {
	it('throws when credentials are missing', () => {
		expect(() => GoogleOAuthProvider.create('id', undefined, 'https://app.local')).toThrow(
			/Google OAuth credentials not configured/,
		);
	});

	it('builds a provider instance from valid credentials', () => {
		const provider = GoogleOAuthProvider.create('id', 'secret', 'https://app.local');
		expect(provider).toBeInstanceOf(GoogleOAuthProvider);
	});
});
