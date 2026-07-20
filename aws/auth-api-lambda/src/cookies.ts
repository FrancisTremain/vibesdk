/**
 * Cookie helpers for API Gateway HTTP API v2's structured cookie
 * support -- `event.cookies` (pre-parsed array) on the way in,
 * `result.cookies` (array of Set-Cookie value strings, one per cookie)
 * on the way out. Simpler than the original's manual Cookie-header
 * parsing (worker/utils/authUtils.ts's `parseCookies`) since API
 * Gateway does that splitting for us.
 *
 * No dev/prod cookie-name-prefix distinction (the original's
 * `__Host-` prefix dance in worker/utils/oauthCookie.ts) -- a Lambda
 * deployment behind API Gateway is always HTTPS, so this always sets
 * `Secure`.
 */

export const ACCESS_TOKEN_COOKIE = 'accessToken';
export const OAUTH_NONCE_COOKIE = 'oauth_nonce';

const OAUTH_NONCE_TTL_SECONDS = 10 * 60;

export function readCookie(cookies: string[] | undefined, name: string): string | null {
	if (!cookies) return null;
	for (const entry of cookies) {
		const eq = entry.indexOf('=');
		if (eq === -1) continue;
		if (entry.slice(0, eq).trim() === name) {
			return decodeURIComponent(entry.slice(eq + 1).trim());
		}
	}
	return null;
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function buildClearCookie(name: string): string {
	return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function accessTokenCookie(token: string, maxAgeSeconds: number): string {
	return buildCookie(ACCESS_TOKEN_COOKIE, token, maxAgeSeconds);
}

export function clearAccessTokenCookie(): string {
	return buildClearCookie(ACCESS_TOKEN_COOKIE);
}

export function oauthNonceCookie(nonce: string): string {
	return buildCookie(OAUTH_NONCE_COOKIE, nonce, OAUTH_NONCE_TTL_SECONDS);
}

export function clearOauthNonceCookie(): string {
	return buildClearCookie(OAUTH_NONCE_COOKIE);
}
