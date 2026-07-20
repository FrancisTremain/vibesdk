import { describe, expect, it } from 'vitest';
import { enforceAllowedEmailCheck, validateEmail, validateRedirectUrl } from './auth-utils';

describe('validateEmail', () => {
	it('accepts a well-formed email', () => {
		expect(validateEmail('user@example.com')).toEqual({ valid: true });
	});

	it('rejects an empty email', () => {
		expect(validateEmail('').valid).toBe(false);
	});

	it('rejects a malformed email', () => {
		expect(validateEmail('not-an-email').valid).toBe(false);
	});

	it('rejects a blocked domain', () => {
		expect(validateEmail('user@10minutemail.com').valid).toBe(false);
	});
});

describe('enforceAllowedEmailCheck', () => {
	it('allows anything when no allowlist is configured', () => {
		expect(enforceAllowedEmailCheck(undefined, 'anyone@example.com')).toEqual({ allowed: true });
	});

	it('allows a case-insensitive match', () => {
		expect(enforceAllowedEmailCheck('Admin@Example.com', 'admin@example.com').allowed).toBe(true);
	});

	it('rejects a non-matching email', () => {
		expect(enforceAllowedEmailCheck('admin@example.com', 'other@example.com').allowed).toBe(false);
	});
});

describe('validateRedirectUrl', () => {
	const requestUrl = 'https://app.example.com/login';

	it('accepts a same-origin relative path', () => {
		expect(validateRedirectUrl('/dashboard', requestUrl)).toBe('/dashboard');
	});

	it('rejects a cross-origin absolute URL', () => {
		expect(validateRedirectUrl('https://evil.example.com/steal', requestUrl)).toBeNull();
	});

	it('rejects a forbidden auth-mutating path', () => {
		expect(validateRedirectUrl('/api/auth/logout', requestUrl)).toBeNull();
		expect(validateRedirectUrl('/oauth/login', requestUrl)).toBeNull();
	});

	it('rejects a nested redirect parameter', () => {
		expect(validateRedirectUrl('/settings?return_url=/oauth/login', requestUrl)).toBeNull();
	});

	it('rejects an unparseable URL', () => {
		expect(validateRedirectUrl('not a url at all', requestUrl)).toBeNull();
	});
});
