/**
 * Double-submit-cookie CSRF protection, ported from
 * worker/services/csrf/CsrfService.ts. The cookie holds
 * `{token, timestamp}` as JSON (not HttpOnly -- the frontend never
 * reads it via document.cookie, but the original didn't mark it
 * HttpOnly either, so this keeps exact parity); the header carries the
 * frontend's own copy of the same token, obtained from the JSON body
 * of GET /api/auth/csrf-token (src/lib/api-client.ts's fetchCsrfToken).
 * A request is valid only if both exist and match.
 *
 * Skipped entirely for GET/HEAD/OPTIONS and for any request presenting
 * an explicit credential (Authorization: Bearer / X-API-Key) --
 * CSRF only matters for the ambient, browser-attached accessToken
 * cookie; a caller that already proves possession of a bearer token
 * isn't relying on the browser to authenticate it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2h, matches worker/config/security.ts's getCSRFConfig default.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface CsrfCookiePayload {
	token: string;
	timestamp: number;
}

export function generateCsrfToken(): string {
	return randomBytes(32).toString('base64url');
}

export function buildCsrfCookie(token: string, maxAgeSeconds: number = CSRF_TOKEN_TTL_SECONDS): string {
	const payload: CsrfCookiePayload = { token, timestamp: Date.now() };
	const value = encodeURIComponent(JSON.stringify(payload));
	return `${CSRF_COOKIE_NAME}=${value}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** For logout-style flows that should also drop any live CSRF cookie. */
export function clearCsrfCookie(): string {
	return `${CSRF_COOKIE_NAME}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookieToken(cookies: string[] | undefined): string | null {
	if (!cookies) return null;
	const entry = cookies.find((c) => c.trim().startsWith(`${CSRF_COOKIE_NAME}=`));
	if (!entry) return null;

	const raw = entry.trim().slice(CSRF_COOKIE_NAME.length + 1);
	try {
		const payload = JSON.parse(decodeURIComponent(raw)) as CsrfCookiePayload;
		if (typeof payload.token !== 'string' || typeof payload.timestamp !== 'number') return null;
		if (Date.now() - payload.timestamp > CSRF_TOKEN_TTL_SECONDS * 1000) return null;
		return payload.token;
	} catch {
		return null;
	}
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export interface CsrfCheckEvent {
	requestContext: { http: { method: string } };
	headers?: Record<string, string | undefined>;
	cookies?: string[];
}

export interface CsrfCheckResult {
	ok: boolean;
	/** Only set when ok is false -- callers map this straight to a 403 errorResponse. */
	reason?: string;
}

export function checkCsrf(event: CsrfCheckEvent): CsrfCheckResult {
	const method = event.requestContext.http.method.toUpperCase();
	if (SAFE_METHODS.has(method)) return { ok: true };

	const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
	if (authHeader?.toLowerCase().startsWith('bearer ')) return { ok: true };
	if (event.headers?.['x-api-key'] ?? event.headers?.['X-API-Key']) return { ok: true };

	const cookieToken = readCookieToken(event.cookies);
	const headerToken = event.headers?.[CSRF_HEADER_NAME] ?? event.headers?.['X-CSRF-Token'];

	if (!cookieToken || !headerToken) return { ok: false, reason: 'missing_token' };
	if (!timingSafeStringEqual(cookieToken, headerToken)) return { ok: false, reason: 'token_mismatch' };
	return { ok: true };
}
