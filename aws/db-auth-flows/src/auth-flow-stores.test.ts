import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import {
	OAuthStateStore,
	AuthAttemptStore,
	PasswordResetTokenStore,
	EmailVerificationTokenStore,
	VerificationOtpStore,
} from './auth-flow-stores';

function table(): DynamoDBDocumentClient {
	return new FakeDynamoDocumentClient() as unknown as DynamoDBDocumentClient;
}

describe('OAuthStateStore', () => {
	it('creates and finds a state record', async () => {
		const store = new OAuthStateStore(table(), 't');
		const created = await store.create({
			state: 'abc123',
			provider: 'github',
			redirectUri: 'https://app.example.com/callback',
			scopes: ['read:user'],
			userId: null,
			codeVerifier: 'verifier',
			nonce: 'nonce',
			expiresAt: Date.now() + 60_000,
		});

		expect(await store.findByState('abc123')).toMatchObject({ id: created.id, provider: 'github' });
	});

	it('consumes a valid state exactly once', async () => {
		const store = new OAuthStateStore(table(), 't');
		await store.create({
			state: 'abc123', provider: 'github', redirectUri: null, scopes: [],
			userId: null, codeVerifier: null, nonce: null, expiresAt: Date.now() + 60_000,
		});

		const first = await store.validateAndConsume('abc123');
		expect(first).not.toBeNull();

		const second = await store.validateAndConsume('abc123');
		expect(second).toBeNull(); // Already used -- CSRF replay rejected.
	});

	it('rejects an expired state', async () => {
		const store = new OAuthStateStore(table(), 't');
		await store.create({
			state: 'abc123', provider: 'github', redirectUri: null, scopes: [],
			userId: null, codeVerifier: null, nonce: null, expiresAt: Date.now() - 1000,
		});

		expect(await store.validateAndConsume('abc123')).toBeNull();
	});

	it('returns null for an unknown state', async () => {
		const store = new OAuthStateStore(table(), 't');
		expect(await store.validateAndConsume('nope')).toBeNull();
	});
});

describe('AuthAttemptStore', () => {
	it('records attempts and counts recent failures', async () => {
		const store = new AuthAttemptStore(table(), 't');
		const now = Date.now();

		await store.record({ identifier: 'user@example.com', attemptType: 'login', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now });
		await store.record({ identifier: 'user@example.com', attemptType: 'login', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now + 1 });
		await store.record({ identifier: 'user@example.com', attemptType: 'login', success: true, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now + 2 });

		expect(await store.countRecentFailures('user@example.com', now - 60_000)).toBe(2);
	});

	it('excludes attempts before the window', async () => {
		const store = new AuthAttemptStore(table(), 't');
		const now = Date.now();
		await store.record({ identifier: 'x', attemptType: 'login', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now - 100_000 });

		expect(await store.countRecentFailures('x', now - 1000)).toBe(0);
	});

	it('filters by attempt type when asked', async () => {
		const store = new AuthAttemptStore(table(), 't');
		const now = Date.now();
		await store.record({ identifier: 'x', attemptType: 'login', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now });
		await store.record({ identifier: 'x', attemptType: 'reset_password', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now });

		expect(await store.countRecentFailures('x', now - 1000, 'login')).toBe(1);
	});

	it('keeps different identifiers fully independent', async () => {
		const store = new AuthAttemptStore(table(), 't');
		const now = Date.now();
		await store.record({ identifier: 'a', attemptType: 'login', success: false, ipAddress: '1.1.1.1', userAgent: null, attemptedAt: now });

		expect(await store.countRecentFailures('b', now - 1000)).toBe(0);
	});
});

describe('PasswordResetTokenStore', () => {
	it('creates, finds, and consumes a token', async () => {
		const store = new PasswordResetTokenStore(table(), 't');
		await store.create({ userId: 'u1', tokenHash: 'hash1', expiresAt: Date.now() + 60_000 });

		expect(await store.findByTokenHash('hash1')).toMatchObject({ userId: 'u1', used: false });
		expect(await store.markUsed('hash1')).toBe(true);
		expect(await store.findByTokenHash('hash1')).toMatchObject({ used: true });
	});

	it('rejects consuming an already-used token', async () => {
		const store = new PasswordResetTokenStore(table(), 't');
		await store.create({ userId: 'u1', tokenHash: 'hash1', expiresAt: Date.now() + 60_000 });
		await store.markUsed('hash1');

		expect(await store.markUsed('hash1')).toBe(false);
	});

	it('rejects consuming an expired token', async () => {
		const store = new PasswordResetTokenStore(table(), 't');
		await store.create({ userId: 'u1', tokenHash: 'hash1', expiresAt: Date.now() - 1000 });

		expect(await store.markUsed('hash1')).toBe(false);
	});

	it('rejects consuming an unknown token', async () => {
		const store = new PasswordResetTokenStore(table(), 't');
		expect(await store.markUsed('nope')).toBe(false);
	});
});

describe('EmailVerificationTokenStore', () => {
	it('creates, finds, and consumes a token', async () => {
		const store = new EmailVerificationTokenStore(table(), 't');
		await store.create({ userId: 'u1', tokenHash: 'hash1', email: 'u1@example.com', expiresAt: Date.now() + 60_000 });

		expect(await store.findByTokenHash('hash1')).toMatchObject({ email: 'u1@example.com' });
		expect(await store.markUsed('hash1')).toBe(true);
		expect(await store.markUsed('hash1')).toBe(false); // Already used.
	});
});

describe('VerificationOtpStore', () => {
	it('finds the latest valid OTP for an email', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
		const store = new VerificationOtpStore(table(), 't');

		await store.create({ email: 'u1@example.com', otp: 'hash-old', expiresAt: Date.now() + 600_000 });
		vi.setSystemTime(new Date('2026-01-15T12:00:01.000Z'));
		await store.create({ email: 'u1@example.com', otp: 'hash-new', expiresAt: Date.now() + 600_000 });

		const latest = await store.findLatestValidForEmail('u1@example.com');
		vi.useRealTimers();

		expect(latest?.otp).toBe('hash-new');
	});

	it('falls through to an older valid OTP once the newer one is used', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
		const store = new VerificationOtpStore(table(), 't');
		const older = await store.create({ email: 'u1@example.com', otp: 'older-still-valid', expiresAt: Date.now() + 600_000 });

		vi.setSystemTime(new Date('2026-01-15T12:00:01.000Z'));
		const newer = await store.create({ email: 'u1@example.com', otp: 'newer-gets-used', expiresAt: Date.now() + 600_000 });

		const beforeUse = await store.findLatestValidForEmail('u1@example.com');
		await store.markUsed('u1@example.com', newer.createdAt);
		const fallenThrough = await store.findLatestValidForEmail('u1@example.com');
		vi.useRealTimers();

		expect(beforeUse?.otp).toBe('newer-gets-used');
		expect(fallenThrough?.otp).toBe('older-still-valid');
		expect(fallenThrough?.id).toBe(older.id);
	});

	it('returns null when no OTP exists for the email', async () => {
		const store = new VerificationOtpStore(table(), 't');
		expect(await store.findLatestValidForEmail('nobody@example.com')).toBeNull();
	});

	it('returns null once the only OTP is marked used', async () => {
		const store = new VerificationOtpStore(table(), 't');
		const otp = await store.create({ email: 'u1@example.com', otp: 'code', expiresAt: Date.now() + 60_000 });

		await store.markUsed('u1@example.com', otp.createdAt);

		expect(await store.findLatestValidForEmail('u1@example.com')).toBeNull();
	});
});
