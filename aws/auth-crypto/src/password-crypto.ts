/**
 * Port of PasswordService (worker/utils/passwordService.ts) and the
 * `pbkdf2` helper it depends on (worker/utils/cryptoUtils.ts). Unlike
 * every other piece AuthService depends on, this one needed almost no
 * changes -- see the module comment in aws/db-auth-flows's README for
 * why AuthService's orchestration layer as a whole wasn't rushed into;
 * this file is one piece of what that port needs, built and verified
 * in isolation first.
 *
 * ONE required change, not zero: the original's timing-safe hash
 * comparison uses `crypto.subtle.timingSafeEqual`, which is a
 * Cloudflare Workers extension to Web Crypto -- not in the Web Crypto
 * standard, not available in Node.js's `crypto.subtle`. Node has the
 * equivalent as `timingSafeEqual` in the built-in `node:crypto` module
 * instead (a different API surface, same guarantee: constant-time
 * comparison regardless of where the inputs first differ, so an
 * attacker can't learn anything from response-time variance). Swapped
 * import, not a behavior change.
 *
 * Everything else -- PBKDF2 hashing via `crypto.subtle.deriveBits`,
 * `crypto.getRandomValues` for the salt -- is standard Web Crypto,
 * supported identically on Node 20.
 */

import { timingSafeEqual } from 'node:crypto';

const SALT_LENGTH = 16;
const ITERATIONS = 100_000; // OWASP recommended minimum, matches the original
const KEY_LENGTH = 32; // 256 bits

async function pbkdf2(
	password: string,
	salt: Uint8Array,
	iterations: number,
	keyLength: number,
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const passwordKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password) as Uint8Array<ArrayBuffer>,
		'PBKDF2',
		false,
		['deriveBits'],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations, hash: 'SHA-256' },
		passwordKey,
		keyLength * 8,
	);
	return new Uint8Array(derivedBits);
}

export class PasswordCrypto {
	async hash(password: string): Promise<string> {
		const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
		const hash = await pbkdf2(password, salt, ITERATIONS, KEY_LENGTH);

		const combined = new Uint8Array(salt.length + hash.length);
		combined.set(salt);
		combined.set(hash, salt.length);

		return Buffer.from(combined).toString('base64');
	}

	async verify(password: string, hashedPassword: string): Promise<boolean> {
		try {
			const combined = new Uint8Array(Buffer.from(hashedPassword, 'base64'));
			const salt = combined.slice(0, SALT_LENGTH);
			const originalHash = combined.slice(SALT_LENGTH);

			const newHash = await pbkdf2(password, salt, ITERATIONS, KEY_LENGTH);

			if (originalHash.length !== newHash.length) return false;
			return timingSafeEqual(originalHash, newHash);
		} catch {
			// Matches the original: malformed stored hash -> verification
			// fails closed, doesn't throw.
			return false;
		}
	}
}
