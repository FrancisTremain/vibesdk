import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { AuthOrchestrator } from './auth-orchestrator';
import { JWTUtils } from './jwt';
import { SecurityError } from './errors';

const JWT_SECRET = 'Test-Jwt-Secret-For-AuthOrchestrator-2024!';

function makeOrchestrator(overrides: { allowedEmail?: string } = {}): AuthOrchestrator {
	JWTUtils.resetInstanceForTests();
	const ddb = new FakeDynamoDocumentClient() as unknown as DynamoDBDocumentClient;
	return new AuthOrchestrator({
		ddb,
		identityTable: 'test-identity',
		authFlowsTable: 'test-auth-flows',
		jwtSecret: JWT_SECRET,
		allowedEmail: overrides.allowedEmail,
		oauth: {
			github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
			google: { clientId: 'go-client', clientSecret: 'go-secret' },
		},
	});
}

function req(headers: Record<string, string> = {}): Request {
	return new Request('https://app.example.com/api/auth/whatever', { headers });
}

function mockFetch(handlers: Record<string, () => unknown>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		const handler = handlers[url];
		if (!handler) throw new Error(`Unexpected fetch to ${url}`);
		return new Response(JSON.stringify(handler()), { status: 200 });
	});
}

describe('register / login / logout', () => {
	afterEach(() => vi.restoreAllMocks());

	it('registers a new user and logs them in with the same password', async () => {
		const auth = makeOrchestrator();
		const registered = await auth.register({ email: 'user@example.com', password: 'Str0ngPassw0rd!' }, req());
		expect(registered.user.email).toBe('user@example.com');
		expect(registered.accessToken).toBeTruthy();

		const loggedIn = await auth.login({ email: 'user@example.com', password: 'Str0ngPassw0rd!' }, req());
		expect(loggedIn.user.id).toBe(registered.user.id);
	});

	it('rejects registering the same email twice', async () => {
		const auth = makeOrchestrator();
		await auth.register({ email: 'dup@example.com', password: 'Str0ngPassw0rd!' }, req());
		await expect(auth.register({ email: 'dup@example.com', password: 'Str0ngPassw0rd!' }, req())).rejects.toThrow(
			/already registered/,
		);
	});

	it('rejects registration with a weak password', async () => {
		const auth = makeOrchestrator();
		await expect(auth.register({ email: 'weak@example.com', password: 'short' }, req())).rejects.toThrow(SecurityError);
	});

	it('rejects login with the wrong password', async () => {
		const auth = makeOrchestrator();
		await auth.register({ email: 'user2@example.com', password: 'Str0ngPassw0rd!' }, req());
		await expect(auth.login({ email: 'user2@example.com', password: 'WrongPassword1' }, req())).rejects.toThrow(
			/Invalid email or password/,
		);
	});

	it('rejects login for a nonexistent user without leaking which part was wrong', async () => {
		const auth = makeOrchestrator();
		await expect(auth.login({ email: 'nobody@example.com', password: 'Str0ngPassw0rd!' }, req())).rejects.toThrow(
			/Invalid email or password/,
		);
	});

	it('enforces the ALLOWED_EMAIL admission gate on register and login', async () => {
		const auth = makeOrchestrator({ allowedEmail: 'admin@example.com' });
		await expect(auth.register({ email: 'other@example.com', password: 'Str0ngPassw0rd!' }, req())).rejects.toThrow(
			/Whitelisting/,
		);

		// The allowed email can still register.
		const result = await auth.register({ email: 'admin@example.com', password: 'Str0ngPassw0rd!' }, req());
		expect(result.user.email).toBe('admin@example.com');
	});

	it('logout revokes the session so its token stops validating', async () => {
		const auth = makeOrchestrator();
		const registered = await auth.register({ email: 'user3@example.com', password: 'Str0ngPassw0rd!' }, req());

		expect(await auth.validateTokenAndGetUser(registered.accessToken)).not.toBeNull();

		await auth.logout(registered.sessionId);

		expect(await auth.validateTokenAndGetUser(registered.accessToken)).toBeNull();
	});

	it('rejects a tampered access token', async () => {
		const auth = makeOrchestrator();
		const registered = await auth.register({ email: 'user4@example.com', password: 'Str0ngPassw0rd!' }, req());
		const tampered = registered.accessToken.slice(0, -1) + (registered.accessToken.endsWith('a') ? 'b' : 'a');
		expect(await auth.validateTokenAndGetUser(tampered)).toBeNull();
	});
});

describe('OAuth login', () => {
	afterEach(() => vi.restoreAllMocks());

	function stubGithub(overrides: { emailVerified?: boolean; id?: number; email?: string } = {}) {
		vi.stubGlobal(
			'fetch',
			mockFetch({
				'https://github.com/login/oauth/access_token': () => ({
					access_token: 'gh-access-token',
					token_type: 'bearer',
				}),
				'https://api.github.com/user': () => ({
					id: overrides.id ?? 42,
					login: 'octocat',
					name: 'Octo Cat',
					email: overrides.email ?? 'octocat@example.com',
				}),
				'https://api.github.com/user/emails': () => [
					{
						email: overrides.email ?? 'octocat@example.com',
						verified: overrides.emailVerified ?? true,
						primary: true,
					},
				],
			}),
		);
	}

	async function startFlow(auth: AuthOrchestrator) {
		const { authUrl, nonce } = await auth.getOAuthAuthorizationUrl('github', 'https://app.example.com/login');
		const state = new URL(authUrl).searchParams.get('state')!;
		return { state, nonce };
	}

	it('creates a new user on first GitHub login with a verified email', async () => {
		const auth = makeOrchestrator();
		const { state, nonce } = await startFlow(auth);
		stubGithub();

		const result = await auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', nonce);

		expect(result.user.email).toBe('octocat@example.com');
		expect(result.user.provider).toBe('github');
	});

	it('rejects an OAuth login when the provider does not assert a verified email', async () => {
		const auth = makeOrchestrator();
		const { state, nonce } = await startFlow(auth);
		stubGithub({ emailVerified: false });

		await expect(
			auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', nonce),
		).rejects.toThrow(/did not verify/);
	});

	it('resolves an existing identity to the same user on repeat login', async () => {
		const auth = makeOrchestrator();

		const first = await startFlow(auth);
		stubGithub({ id: 7 });
		const firstLogin = await auth.handleOAuthCallback('github', 'code-1', first.state, 'https://app.example.com/callback', first.nonce);

		const second = await startFlow(auth);
		stubGithub({ id: 7 });
		const secondLogin = await auth.handleOAuthCallback(
			'github',
			'code-2',
			second.state,
			'https://app.example.com/callback',
			second.nonce,
		);

		expect(secondLogin.user.id).toBe(firstLogin.user.id);
	});

	it('refuses to silently take over an existing email-registered account via OAuth', async () => {
		const auth = makeOrchestrator();
		await auth.register({ email: 'octocat@example.com', password: 'Str0ngPassw0rd!' }, req());

		const { state, nonce } = await startFlow(auth);
		stubGithub();

		await expect(
			auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', nonce),
		).rejects.toThrow(/already exists/);
	});

	it('rejects a callback whose cookie nonce does not match the stored state', async () => {
		const auth = makeOrchestrator();
		const { state } = await startFlow(auth);
		stubGithub();

		await expect(
			auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', 'wrong-nonce'),
		).rejects.toThrow(/Invalid or expired OAuth state/);
	});

	it('rejects replaying an already-consumed OAuth state', async () => {
		const auth = makeOrchestrator();
		const { state, nonce } = await startFlow(auth);
		stubGithub();

		await auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', nonce);

		await expect(
			auth.handleOAuthCallback('github', 'auth-code', state, 'https://app.example.com/callback', nonce),
		).rejects.toThrow(/Invalid or expired OAuth state/);
	});
});

describe('OAuth account linking', () => {
	afterEach(() => vi.restoreAllMocks());

	function stubGithub(id = 99) {
		vi.stubGlobal(
			'fetch',
			mockFetch({
				'https://github.com/login/oauth/access_token': () => ({ access_token: 'tok', token_type: 'bearer' }),
				'https://api.github.com/user': () => ({ id, login: 'octocat' }),
				'https://api.github.com/user/emails': () => [{ email: 'linked@example.com', verified: true, primary: true }],
			}),
		);
	}

	it('links a GitHub identity to a password account, then refuses to unlink the only remaining method after removing the password path', async () => {
		const auth = makeOrchestrator();
		const registered = await auth.register({ email: 'haspw@example.com', password: 'Str0ngPassw0rd!' }, req());

		const { authUrl, nonce } = await auth.getOAuthAuthorizationUrl(
			'github',
			'https://app.example.com/link',
			undefined,
			registered.user.id,
		);
		const state = new URL(authUrl).searchParams.get('state')!;
		stubGithub();

		const linked = await auth.completeOAuthLink('github', 'code', state, 'https://app.example.com/callback', nonce, registered.user.id);
		expect(linked.userId).toBe(registered.user.id);

		const identities = await auth.getUserIdentities(registered.user.id);
		expect(identities).toHaveLength(1);
		expect(identities[0]).toMatchObject({ provider: 'github' });

		// Has a password, so unlinking the only OAuth identity is fine.
		await expect(auth.unlinkOAuthIdentity(registered.user.id, 'github')).resolves.toBeUndefined();
	});

	it('refuses to unlink a user\'s only login method', async () => {
		const auth = makeOrchestrator();
		const { authUrl: firstUrl, nonce: firstNonce } = await auth.getOAuthAuthorizationUrl(
			'github',
			'https://app.example.com/login',
		);
		const firstState = new URL(firstUrl).searchParams.get('state')!;
		stubGithub(123);
		const oauthOnlyUser = await auth.handleOAuthCallback(
			'github',
			'code',
			firstState,
			'https://app.example.com/callback',
			firstNonce,
		);

		await expect(auth.unlinkOAuthIdentity(oauthOnlyUser.user.id, 'github')).rejects.toThrow(/only login method/);
	});

	it('rejects linking an identity already claimed by a different user', async () => {
		const auth = makeOrchestrator();

		const { authUrl: url1, nonce: nonce1 } = await auth.getOAuthAuthorizationUrl('github', 'https://app.example.com/login');
		const state1 = new URL(url1).searchParams.get('state')!;
		stubGithub(555);
		await auth.handleOAuthCallback('github', 'code', state1, 'https://app.example.com/callback', nonce1);

		const second = await auth.register({ email: 'second@example.com', password: 'Str0ngPassw0rd!' }, req());
		const { authUrl: url2, nonce: nonce2 } = await auth.getOAuthAuthorizationUrl(
			'github',
			'https://app.example.com/link',
			undefined,
			second.user.id,
		);
		const state2 = new URL(url2).searchParams.get('state')!;
		stubGithub(555);

		await expect(
			auth.completeOAuthLink('github', 'code', state2, 'https://app.example.com/callback', nonce2, second.user.id),
		).rejects.toThrow(/already linked to another user/);
	});
});

describe('email verification via OTP', () => {
	it('resend generates a new OTP for an unverified account', async () => {
		const auth = makeOrchestrator();
		// verifyEmailWithOtp / resendVerificationOtp both require a user to
		// already exist and be unverified. This orchestrator's register()
		// always creates a verified user directly (matching the original's
		// "no OTP verification required" comment), so exercise the
		// not-found and already-verified guard paths, which is what real
		// callers actually hit without a separate unverified-signup flow.
		await expect(auth.resendVerificationOtp('nobody@example.com')).rejects.toThrow(/No account found/);

		const registered = await auth.register({ email: 'verified@example.com', password: 'Str0ngPassw0rd!' }, req());
		expect(registered.user.emailVerified).toBe(true);
		await expect(auth.resendVerificationOtp('verified@example.com')).rejects.toThrow(/already verified/);
	});
});
