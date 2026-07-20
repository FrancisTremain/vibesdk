import { describe, expect, it } from 'vitest';
import { PasswordCrypto } from './password-crypto';

describe('PasswordCrypto', () => {
	const crypto = new PasswordCrypto();

	it('hashes and verifies a correct password', async () => {
		const hashed = await crypto.hash('CorrectHorse123');
		expect(await crypto.verify('CorrectHorse123', hashed)).toBe(true);
	});

	it('rejects an incorrect password', async () => {
		const hashed = await crypto.hash('CorrectHorse123');
		expect(await crypto.verify('WrongPassword456', hashed)).toBe(false);
	});

	it('produces a different hash each time (random salt)', async () => {
		const first = await crypto.hash('SamePassword1');
		const second = await crypto.hash('SamePassword1');
		expect(first).not.toBe(second);
		expect(await crypto.verify('SamePassword1', first)).toBe(true);
		expect(await crypto.verify('SamePassword1', second)).toBe(true);
	});

	it('fails closed on a malformed stored hash rather than throwing', async () => {
		await expect(crypto.verify('anything', 'not-valid-base64!!!')).resolves.toBe(false);
		await expect(crypto.verify('anything', '')).resolves.toBe(false);
		await expect(crypto.verify('anything', Buffer.from('too-short').toString('base64'))).resolves.toBe(
			false,
		);
	});

	it('rejects when the stored hash length does not match', async () => {
		const short = Buffer.from(new Uint8Array(20)).toString('base64');
		expect(await crypto.verify('password', short)).toBe(false);
	});
});
