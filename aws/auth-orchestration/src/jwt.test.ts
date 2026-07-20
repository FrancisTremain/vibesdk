import { describe, expect, it, beforeEach } from 'vitest';
import { JWTUtils } from './jwt';

const GOOD_SECRET = 'Test-Jwt-Secret-For-AuthOrchestrator-2024!';

describe('JWTUtils secret validation', () => {
	beforeEach(() => {
		JWTUtils.resetInstanceForTests();
	});

	it('rejects a secret shorter than 32 characters', () => {
		expect(() => JWTUtils.getInstance('short')).toThrow(/at least 32 characters/);
	});

	it('rejects a known weak secret', () => {
		expect(() => JWTUtils.getInstance('secret'.padEnd(32, 'x'))).toThrow();
	});

	it('rejects a secret with fewer than 3 character types', () => {
		expect(() => JWTUtils.getInstance('a'.repeat(40))).toThrow(/3 different character types/);
	});

	it('rejects a secret with repeating patterns', () => {
		expect(() => JWTUtils.getInstance('Aaaa1111!!!!Aaaa1111!!!!Aaaa1111!!!!')).toThrow(/repetitive patterns/);
	});

	it('accepts a strong secret', () => {
		expect(() => JWTUtils.getInstance(GOOD_SECRET)).not.toThrow();
	});
});

describe('JWTUtils sign/verify', () => {
	beforeEach(() => {
		JWTUtils.resetInstanceForTests();
	});

	it('round-trips an access token', async () => {
		const jwt = JWTUtils.getInstance(GOOD_SECRET);
		const { accessToken } = await jwt.createAccessToken('user-1', 'user@example.com', 'session-1', 3600);

		const payload = await jwt.verifyToken(accessToken);
		expect(payload).toMatchObject({
			sub: 'user-1',
			email: 'user@example.com',
			sessionId: 'session-1',
			type: 'access',
		});
	});

	it('rejects a tampered token', async () => {
		const jwt = JWTUtils.getInstance(GOOD_SECRET);
		const { accessToken } = await jwt.createAccessToken('user-1', 'user@example.com', 'session-1', 3600);
		const tampered = accessToken.slice(0, -2) + 'xx';

		expect(await jwt.verifyToken(tampered)).toBeNull();
	});

	it('rejects an expired token', async () => {
		const jwt = JWTUtils.getInstance(GOOD_SECRET);
		const { accessToken } = await jwt.createAccessToken('user-1', 'user@example.com', 'session-1', -10);

		expect(await jwt.verifyToken(accessToken)).toBeNull();
	});

	it('hashes a token deterministically', async () => {
		const jwt = JWTUtils.getInstance(GOOD_SECRET);
		const hash1 = await jwt.hashToken('some-token');
		const hash2 = await jwt.hashToken('some-token');
		expect(hash1).toBe(hash2);
	});
});
