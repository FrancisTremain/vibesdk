/**
 * Inlined from worker/types/auth-types.ts -- this package doesn't depend
 * on the rest of the worker codebase, only the shapes these OAuth
 * clients actually consume/produce.
 */

export type OAuthProvider = 'google' | 'github';

export interface OAuthUserInfo {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	emailVerified?: boolean;
}

/**
 * Minimal structured logger interface, satisfied by `console` or by a
 * caller's own logger. The original's `createLogger` (worker/logger/)
 * is wired into Sentry and Cloudflare-specific request context -- not
 * portable, and not worth carrying into a package with zero other
 * Cloudflare dependencies. Callers running in the main worker can pass
 * their real logger in; callers running elsewhere can pass `console` or
 * omit it entirely (defaults to a no-op).
 */
export interface Logger {
	error(message: string, ...args: unknown[]): void;
}

export const noopLogger: Logger = { error: () => {} };
