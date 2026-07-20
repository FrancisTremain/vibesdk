import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { UserStore } from './identity-store';
import { SessionStore } from './session-store';
import type { NewSession } from './types';

function makeStores(): { users: UserStore; sessions: SessionStore } {
	const fake = new FakeDynamoDocumentClient();
	const table = fake as unknown as DynamoDBDocumentClient;
	return { users: new UserStore(table, 'test-identity'), sessions: new SessionStore(table, 'test-identity') };
}

function baseSession(overrides: Partial<NewSession> = {}): NewSession {
	return {
		userId: 'u1',
		deviceInfo: null,
		userAgent: 'test-agent',
		ipAddress: '127.0.0.1',
		isRevoked: false,
		revokedAt: null,
		revokedReason: null,
		accessTokenHash: 'hash',
		refreshTokenHash: '',
		expiresAt: Date.now() + 60_000,
		lastActivity: Date.now(),
		...overrides,
	};
}

describe('getSessionById / getSessionCreatedAt', () => {
	it('finds a session by its own id, created via UserStore.createSession', async () => {
		const { users, sessions } = makeStores();
		const created = await users.createSession(baseSession());

		const found = await sessions.getSessionById(created.id);
		expect(found).toMatchObject({ id: created.id, userId: 'u1' });
		expect(await sessions.getSessionCreatedAt(created.id)).toBe(created.createdAt);
	});

	it('returns null for an unknown session id', async () => {
		const { sessions } = makeStores();
		expect(await sessions.getSessionById('nope')).toBeNull();
		expect(await sessions.getSessionCreatedAt('nope')).toBeNull();
	});
});

describe('revocation', () => {
	it('revokes a single session by id and userId, excluding it from getUserSessions', async () => {
		const { users, sessions } = makeStores();
		const created = await users.createSession(baseSession());

		await sessions.revokeUserSession(created.id, 'u1');

		const active = await sessions.getUserSessions('u1');
		expect(active).toEqual([]);

		const raw = await sessions.getSessionById(created.id);
		expect(raw).toMatchObject({ isRevoked: true, revokedReason: 'user_logout' });
	});

	it('revokes all sessions for a user', async () => {
		const { users, sessions } = makeStores();
		await users.createSession(baseSession());
		await users.createSession(baseSession());

		await sessions.revokeAllUserSessions('u1');

		expect(await sessions.getUserSessions('u1')).toEqual([]);
	});

	it('revokeSessionId works with only the session id, no userId needed by the caller', async () => {
		const { users, sessions } = makeStores();
		const created = await users.createSession(baseSession());

		await sessions.revokeSessionId(created.id);

		const raw = await sessions.getSessionById(created.id);
		expect(raw?.isRevoked).toBe(true);
	});

	it('revokeSessionId is a no-op, not a throw, for an unknown session (matches logout-flow behavior)', async () => {
		const { sessions } = makeStores();
		await expect(sessions.revokeSessionId('nope')).resolves.toBeUndefined();
	});
});

describe('getUserSessions', () => {
	it('excludes expired sessions', async () => {
		const { users, sessions } = makeStores();
		await users.createSession(baseSession({ expiresAt: Date.now() - 1000 }));

		expect(await sessions.getUserSessions('u1')).toEqual([]);
	});

	it('sorts by most recently active first', async () => {
		const { users, sessions } = makeStores();
		const older = await users.createSession(baseSession({ lastActivity: Date.now() - 5000 }));
		const newer = await users.createSession(baseSession({ lastActivity: Date.now() }));

		const active = await sessions.getUserSessions('u1');
		expect(active.map((s) => s.id)).toEqual([newer.id, older.id]);
	});
});

describe('cleanupUserSessions', () => {
	it('keeps only the 5 most recently active sessions, deleting the rest', async () => {
		const { users, sessions } = makeStores();
		const created = [];
		for (let i = 0; i < 7; i++) {
			created.push(await users.createSession(baseSession({ lastActivity: Date.now() + i })));
		}

		const removed = await sessions.cleanupUserSessions('u1');
		expect(removed).toBe(2);

		const remainingIds = (await sessions.getUserSessions('u1')).map((s) => s.id);
		expect(remainingIds).toHaveLength(5);
		// The two oldest (index 0 and 1) should be gone.
		expect(remainingIds).not.toContain(created[0]!.id);
		expect(remainingIds).not.toContain(created[1]!.id);
	});

	it('is a no-op when at or under the limit', async () => {
		const { users, sessions } = makeStores();
		await users.createSession(baseSession());
		await users.createSession(baseSession());

		expect(await sessions.cleanupUserSessions('u1')).toBe(0);
	});

	it('also removes the SESSIONID# lookup for a pruned session', async () => {
		const { users, sessions } = makeStores();
		const oldest = await users.createSession(baseSession({ lastActivity: Date.now() - 100_000 }));
		for (let i = 0; i < 5; i++) {
			await users.createSession(baseSession({ lastActivity: Date.now() + i }));
		}

		await sessions.cleanupUserSessions('u1');

		expect(await sessions.getSessionById(oldest.id)).toBeNull();
	});
});

describe('forceLogoutAllOtherSessions', () => {
	it('deletes every session except the current one', async () => {
		const { users, sessions } = makeStores();
		const current = await users.createSession(baseSession());
		const other1 = await users.createSession(baseSession());
		const other2 = await users.createSession(baseSession());

		const removed = await sessions.forceLogoutAllOtherSessions('u1', current.id);
		expect(removed).toBe(2);

		expect(await sessions.getSessionById(current.id)).not.toBeNull();
		expect(await sessions.getSessionById(other1.id)).toBeNull();
		expect(await sessions.getSessionById(other2.id)).toBeNull();
	});
});
