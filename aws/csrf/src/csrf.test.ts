import { describe, expect, it } from 'vitest';
import { buildCsrfCookie, checkCsrf, generateCsrfToken, CSRF_HEADER_NAME } from './csrf';

function eventFor(method: string, opts: { cookies?: string[]; headers?: Record<string, string> } = {}) {
	return {
		requestContext: { http: { method } },
		headers: opts.headers,
		cookies: opts.cookies,
	};
}

function cookieOnly(cookie: string): string {
	// buildCsrfCookie returns a full Set-Cookie line; event.cookies entries
	// (API Gateway v2 shape) are just "name=value" pairs.
	return cookie.split(';')[0]!;
}

describe('checkCsrf', () => {
	it('allows safe methods without any token', () => {
		expect(checkCsrf(eventFor('GET'))).toEqual({ ok: true });
		expect(checkCsrf(eventFor('HEAD'))).toEqual({ ok: true });
		expect(checkCsrf(eventFor('OPTIONS'))).toEqual({ ok: true });
	});

	it('allows a bearer-token request without a CSRF cookie/header', () => {
		const result = checkCsrf(eventFor('POST', { headers: { authorization: 'Bearer sometoken' } }));
		expect(result).toEqual({ ok: true });
	});

	it('allows an X-API-Key request without a CSRF cookie/header', () => {
		const result = checkCsrf(eventFor('POST', { headers: { 'x-api-key': 'abc' } }));
		expect(result).toEqual({ ok: true });
	});

	it('rejects a state-changing request with no cookie and no header', () => {
		const result = checkCsrf(eventFor('POST'));
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_token');
	});

	it('rejects a state-changing request with a header but no cookie', () => {
		const result = checkCsrf(eventFor('POST', { headers: { [CSRF_HEADER_NAME]: 'abc' } }));
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_token');
	});

	it('rejects a state-changing request with a cookie but no header', () => {
		const token = generateCsrfToken();
		const result = checkCsrf(eventFor('POST', { cookies: [cookieOnly(buildCsrfCookie(token))] }));
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_token');
	});

	it('rejects a mismatched cookie/header pair', () => {
		const token = generateCsrfToken();
		const result = checkCsrf(
			eventFor('POST', {
				cookies: [cookieOnly(buildCsrfCookie(token))],
				headers: { [CSRF_HEADER_NAME]: generateCsrfToken() },
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('token_mismatch');
	});

	it('accepts a matching cookie/header pair', () => {
		const token = generateCsrfToken();
		const result = checkCsrf(
			eventFor('PUT', {
				cookies: [cookieOnly(buildCsrfCookie(token))],
				headers: { [CSRF_HEADER_NAME]: token },
			}),
		);
		expect(result).toEqual({ ok: true });
	});

	it('rejects an expired cookie token', () => {
		const token = generateCsrfToken();
		// Force an already-expired timestamp by building the cookie with a
		// negative maxAge marker isn't representative of real expiry, so
		// simulate directly via a hand-built cookie with an old timestamp.
		const stale = encodeURIComponent(JSON.stringify({ token, timestamp: Date.now() - 3 * 60 * 60 * 1000 }));
		const result = checkCsrf(
			eventFor('POST', {
				cookies: [`csrf-token=${stale}`],
				headers: { [CSRF_HEADER_NAME]: token },
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_token');
	});

	it('rejects a malformed cookie value', () => {
		const token = generateCsrfToken();
		const result = checkCsrf(
			eventFor('POST', {
				cookies: ['csrf-token=not-json'],
				headers: { [CSRF_HEADER_NAME]: token },
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_token');
	});

	it('falls back to the capitalized header/cookie name variants', () => {
		const token = generateCsrfToken();
		const result = checkCsrf(
			eventFor('POST', {
				cookies: [cookieOnly(buildCsrfCookie(token))],
				headers: { 'X-CSRF-Token': token },
			}),
		);
		expect(result).toEqual({ ok: true });
	});
});
