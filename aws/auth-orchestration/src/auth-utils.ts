/**
 * Port of the subset of worker/utils/authUtils.ts that AuthOrchestrator
 * needs: the deployment-wide email allowlist gate, redirect-URL
 * validation (open-redirect prevention), request metadata extraction
 * for auth-attempt logging, and the User-row -> AuthUser response
 * mapper. Cookie/token-extraction helpers from the original
 * (`extractToken`, `setSecureAuthCookies`, etc.) are HTTP-response
 * concerns for a controller layer that doesn't exist in this package
 * (no HTTP framework here, just the orchestration logic) -- not ported.
 */

import type { Logger } from 'vibesdk-oauth-clients';
import type { User } from 'vibesdk-db-identity';
import type { AuthUser } from './types';

/**
 * Enforce the deployment-level email allowlist (ALLOWED_EMAIL).
 * Comparison is case-insensitive on both sides. No-op when unset.
 */
export function enforceAllowedEmailCheck(
	allowedEmail: string | undefined,
	email: string,
): { allowed: boolean; message?: string } {
	if (!allowedEmail) return { allowed: true };
	if (email.toLowerCase() !== allowedEmail.toLowerCase()) {
		return { allowed: false, message: `Email Whitelisting is enabled. Please use the allowed email.` };
	}
	return { allowed: true };
}

export interface RequestMetadata {
	ipAddress: string;
	userAgent: string;
	referer?: string;
	origin?: string;
}

/** Extracts client metadata from a fetch Request, for auth-attempt logging. */
export function extractRequestMetadata(request: Request): RequestMetadata {
	const headers = request.headers;
	return {
		ipAddress:
			headers.get('CF-Connecting-IP') ||
			headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
			headers.get('X-Real-IP') ||
			'unknown',
		userAgent: headers.get('User-Agent') || 'unknown',
		referer: headers.get('Referer') || undefined,
		origin: headers.get('Origin') || undefined,
	};
}

/**
 * Port of the default-config path of validateEmail
 * (worker/utils/validationUtils.ts) -- length, format, and a small
 * blocked-domain list. The original's configurable
 * allowPlusAddressing/allowInternational/blockedDomains overrides had
 * no caller passing anything but the default in AuthService, so only
 * the default behavior is ported.
 */
export function validateEmail(email: string): { valid: boolean; error?: string } {
	if (!email || typeof email !== 'string') {
		return { valid: false, error: 'Email is required' };
	}
	if (email.length > 254) {
		return { valid: false, error: 'Email must be less than 254 characters' };
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { valid: false, error: 'Invalid email format' };
	}
	const domain = email.split('@')[1]?.toLowerCase();
	if (domain && ['10minutemail.com', 'tempmail.org'].includes(domain)) {
		return { valid: false, error: 'Email domain is not allowed' };
	}
	return { valid: true };
}

export function mapUserResponse(user: Pick<User, 'id' | 'email'> & Partial<User>): AuthUser {
	return {
		id: user.id,
		email: user.email,
		displayName: user.displayName || undefined,
		username: user.username || undefined,
		avatarUrl: user.avatarUrl || undefined,
		bio: user.bio || undefined,
		timezone: user.timezone || undefined,
		provider: user.provider || undefined,
		emailVerified: user.emailVerified || undefined,
		createdAt: user.createdAt ? new Date(user.createdAt) : undefined,
	};
}

/**
 * Validate and sanitize a post-login redirect URL to prevent open
 * redirects. Returns null (and logs via the supplied logger) when the
 * URL is cross-origin, targets a privileged auth-mutating path, or
 * carries a nested redirect parameter that could chain into another
 * flow -- unchanged from the original's checks.
 */
export function validateRedirectUrl(
	redirectUrl: string,
	requestUrl: string,
	logger: Logger = { error: () => {} },
): string | null {
	try {
		const origin = new URL(requestUrl).origin;
		const redirectUrlObj = redirectUrl.startsWith('/') ? new URL(redirectUrl, origin) : new URL(redirectUrl);

		if (redirectUrlObj.origin !== origin) {
			logger.error('Redirect URL rejected: different origin', { redirectUrl, origin });
			return null;
		}

		const forbiddenPaths = ['/api/auth/', '/logout', '/api/github-exporter/', '/oauth/', '/auth/'];
		if (forbiddenPaths.some((path) => redirectUrlObj.pathname.startsWith(path))) {
			logger.error('Redirect URL rejected: forbidden path', { redirectUrl });
			return null;
		}

		const nestedRedirectParams = ['return_url', 'redirect_url', 'continue'];
		if (nestedRedirectParams.some((param) => redirectUrlObj.searchParams.has(param))) {
			logger.error('Redirect URL rejected: nested redirect parameter', { redirectUrl });
			return null;
		}

		return redirectUrl;
	} catch (error) {
		logger.error('Invalid redirect URL format', { redirectUrl, error });
		return null;
	}
}
