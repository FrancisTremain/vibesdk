import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { UserStore, ApiKeyStore } from './identity-store';
import type { NewUser } from './types';

function makeStores(): {
	users: UserStore;
	apiKeys: ApiKeyStore;
	fake: FakeDynamoDocumentClient;
} {
	const fake = new FakeDynamoDocumentClient();
	const table = fake as unknown as DynamoDBDocumentClient;
	return {
		users: new UserStore(table, 'test-identity'),
		apiKeys: new ApiKeyStore(table, 'test-identity'),
		fake,
	};
}

function baseNewUser(overrides: Partial<NewUser> = {}): NewUser {
	// providerId defaults to something derived from email so two test
	// users don't accidentally collide on the OAuth provider+providerId
	// lookup unless a test is deliberately exercising that path.
	const email = overrides.email ?? 'alice@example.com';
	return {
		email,
		username: 'alice',
		displayName: 'Alice',
		avatarUrl: null,
		bio: null,
		provider: 'github',
		providerId: `gh-${email}`,
		emailVerified: true,
		passwordHash: null,
		failedLoginAttempts: 0,
		lockedUntil: null,
		passwordChangedAt: null,
		preferences: '{}',
		theme: 'system',
		timezone: 'UTC',
		aiGatewayEnabled: null,
		isActive: true,
		isSuspended: false,
		lastActiveAt: null,
		deletedAt: null,
		...overrides,
	};
}

describe('createUser / findUser', () => {
	it('creates a user and finds it by id, email, and provider', async () => {
		const { users } = makeStores();
		const created = await users.createUser(baseNewUser());

		expect(await users.findUser({ id: created.id })).toMatchObject({ email: 'alice@example.com' });
		expect(await users.findUser({ email: 'alice@example.com' })).toMatchObject({ id: created.id });
		expect(
			await users.findUser({ provider: { name: 'github', id: 'gh-alice@example.com' } }),
		).toMatchObject({ id: created.id });
	});

	it('returns null for an unknown lookup', async () => {
		const { users } = makeStores();
		expect(await users.findUser({ email: 'nobody@example.com' })).toBeNull();
	});

	it('rejects a duplicate email atomically, without leaving a partial user behind', async () => {
		const { users } = makeStores();
		await users.createUser(baseNewUser({ email: 'dup@example.com', username: 'first' }));

		await expect(
			users.createUser(baseNewUser({ email: 'dup@example.com', username: 'second' })),
		).rejects.toThrow();

		// The second user must not exist under any lookup -- the whole
		// transaction rolled back, not just the failing email claim.
		expect(await users.isUsernameAvailable('second')).toBe(true);
	});

	it('rejects a duplicate username atomically', async () => {
		const { users } = makeStores();
		await users.createUser(baseNewUser({ email: 'a@example.com', username: 'taken' }));

		await expect(
			users.createUser(baseNewUser({ email: 'b@example.com', username: 'taken' })),
		).rejects.toThrow();

		// The second user's email claim must also have rolled back.
		expect(await users.findUser({ email: 'b@example.com' })).toBeNull();
	});

	it('allows a user with no username', async () => {
		const { users } = makeStores();
		const created = await users.createUser(baseNewUser({ username: null }));
		expect(await users.findUser({ id: created.id })).toMatchObject({ username: null });
	});
});

describe('username management', () => {
	it('reports availability correctly, including self-exclusion', async () => {
		const { users } = makeStores();
		const alice = await users.createUser(baseNewUser({ username: 'alice' }));

		expect(await users.isUsernameAvailable('alice')).toBe(false);
		expect(await users.isUsernameAvailable('alice', alice.id)).toBe(true);
		expect(await users.isUsernameAvailable('bob')).toBe(true);
	});

	it('reassigns a username, releasing the old one', async () => {
		const { users } = makeStores();
		const alice = await users.createUser(baseNewUser({ username: 'alice' }));

		await users.updateUserProfile(alice.id, { username: 'alice2' });

		expect(await users.isUsernameAvailable('alice')).toBe(true);
		expect(await users.isUsernameAvailable('alice2')).toBe(false);
		expect(await users.findUser({ id: alice.id })).toMatchObject({ username: 'alice2' });
	});

	it('rejects claiming a username someone else already has', async () => {
		const { users } = makeStores();
		await users.createUser(baseNewUser({ email: 'a@example.com', username: 'taken' }));
		const bob = await users.createUser(baseNewUser({ email: 'b@example.com', username: 'bob' }));

		const result = await users.updateUserProfileWithValidation(bob.id, { username: 'taken' });
		expect(result).toEqual({ success: false, message: 'Username already taken' });

		// Bob's own username must be unaffected by the failed attempt.
		expect(await users.findUser({ id: bob.id })).toMatchObject({ username: 'bob' });
	});

	it('validates username format and length before touching storage', async () => {
		const { users } = makeStores();
		const alice = await users.createUser(baseNewUser());

		expect(await users.updateUserProfileWithValidation(alice.id, { username: 'a' })).toEqual({
			success: false,
			message: 'Username must be between 3 and 30 characters',
		});
		expect(
			await users.updateUserProfileWithValidation(alice.id, { username: 'has space' }),
		).toEqual({
			success: false,
			message: 'Username can only contain letters, numbers, underscores, and hyphens',
		});
		expect(await users.updateUserProfileWithValidation(alice.id, { username: 'admin' })).toEqual({
			success: false,
			message: 'Username is reserved',
		});
	});
});

describe('AI Gateway preference', () => {
	it('defaults to off for a Cloudflare-signed-in user, on otherwise', async () => {
		const { users } = makeStores();
		const cfUser = await users.createUser(baseNewUser({ provider: 'cloudflare', email: 'cf@x.com', username: null }));
		const githubUser = await users.createUser(baseNewUser({ provider: 'github', email: 'gh@x.com', username: 'gh' }));

		expect(await users.getAiGatewayPreference(cfUser.id)).toEqual({
			enabled: false,
			isExplicit: false,
		});
		expect(await users.getAiGatewayPreference(githubUser.id)).toEqual({
			enabled: true,
			isExplicit: false,
		});
	});

	it('respects an explicit preference once set', async () => {
		const { users } = makeStores();
		const cfUser = await users.createUser(baseNewUser({ provider: 'cloudflare', email: 'cf@x.com', username: null }));

		await users.setAiGatewayPreference(cfUser.id, true);

		expect(await users.getAiGatewayPreference(cfUser.id)).toEqual({
			enabled: true,
			isExplicit: true,
		});
	});
});

describe('sessions', () => {
	it('creates a session and finds it by its own id (no userId needed by the caller)', async () => {
		const { users } = makeStores();
		const alice = await users.createUser(baseNewUser());
		const session = await users.createSession({
			userId: alice.id,
			deviceInfo: null,
			userAgent: null,
			ipAddress: null,
			isRevoked: false,
			revokedAt: null,
			revokedReason: null,
			accessTokenHash: 'hash1',
			refreshTokenHash: 'hash2',
			expiresAt: Date.now() + 60_000,
			lastActivity: null,
		});

		const found = await users.findValidSession(session.id);
		expect(found).toMatchObject({ id: session.id, userId: alice.id });
	});

	it('treats an expired session as not found', async () => {
		const { users } = makeStores();
		const alice = await users.createUser(baseNewUser());
		const session = await users.createSession({
			userId: alice.id,
			deviceInfo: null,
			userAgent: null,
			ipAddress: null,
			isRevoked: false,
			revokedAt: null,
			revokedReason: null,
			accessTokenHash: 'hash1',
			refreshTokenHash: 'hash2',
			expiresAt: Date.now() - 1000, // already expired
			lastActivity: null,
		});

		expect(await users.findValidSession(session.id)).toBeNull();
	});

	it('returns null for an unknown session id', async () => {
		const { users } = makeStores();
		expect(await users.findValidSession('nope')).toBeNull();
	});
});

describe('API keys', () => {
	it('creates a key and finds it by id and by hash', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());

		const keyId = await apiKeys.createApiKey({
			userId: alice.id,
			name: 'CI key',
			keyHash: 'hash-abc',
			keyPreview: 'sk_...abc',
		});

		expect(await apiKeys.getApiKeyById(keyId)).toMatchObject({ id: keyId, name: 'CI key' });
		expect(await apiKeys.findApiKeyByHash('hash-abc')).toMatchObject({ id: keyId });
	});

	it('lists a user\'s keys, newest first', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
		await apiKeys.createApiKey({ userId: alice.id, name: 'first', keyHash: 'h1', keyPreview: 'p1' });
		vi.setSystemTime(new Date('2026-01-15T12:00:01.000Z'));
		await apiKeys.createApiKey({ userId: alice.id, name: 'second', keyHash: 'h2', keyPreview: 'p2' });
		vi.useRealTimers();

		const list = await apiKeys.getUserApiKeys(alice.id);
		expect(list.map((k) => k.name)).toEqual(['second', 'first']);
	});

	it('revokes a key so it stops resolving by hash', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());
		const keyId = await apiKeys.createApiKey({
			userId: alice.id,
			name: 'k',
			keyHash: 'h',
			keyPreview: 'p',
		});

		await apiKeys.revokeApiKey(keyId, alice.id);

		expect(await apiKeys.findApiKeyByHash('h')).toBeNull();
		const byId = await apiKeys.getApiKeyById(keyId);
		expect(byId?.isActive).toBe(false);
	});

	it('increments request count and sets lastUsed on use', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());
		const keyId = await apiKeys.createApiKey({
			userId: alice.id,
			name: 'k',
			keyHash: 'h',
			keyPreview: 'p',
		});

		await apiKeys.updateApiKeyLastUsed(keyId);
		await apiKeys.updateApiKeyLastUsed(keyId);

		const key = await apiKeys.getApiKeyById(keyId);
		expect(key?.requestCount).toBe(2);
		expect(key?.lastUsed).not.toBeNull();
	});

	it('enforces key name uniqueness and counts active keys per user', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());
		await apiKeys.createApiKey({ userId: alice.id, name: 'ci', keyHash: 'h1', keyPreview: 'p1' });

		expect(await apiKeys.isApiKeyNameUnique(alice.id, 'ci')).toBe(false);
		expect(await apiKeys.isApiKeyNameUnique(alice.id, 'other')).toBe(true);
		expect(await apiKeys.getActiveApiKeyCount(alice.id)).toBe(1);
	});

	it('rejects two active keys with the same hash (hash uniqueness)', async () => {
		const { users, apiKeys } = makeStores();
		const alice = await users.createUser(baseNewUser());
		await apiKeys.createApiKey({ userId: alice.id, name: 'a', keyHash: 'dup', keyPreview: 'p' });

		await expect(
			apiKeys.createApiKey({ userId: alice.id, name: 'b', keyHash: 'dup', keyPreview: 'p' }),
		).rejects.toThrow();
	});
});
