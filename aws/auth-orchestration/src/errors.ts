/**
 * Port of SecurityError/SecurityErrorType (shared/types/errors.ts).
 * `RateLimitExceededError` and `UsageLimitExceededError` from the same
 * file are not ported -- they depend on `worker/services/rate-limit/`
 * types unrelated to authentication, and nothing here throws them.
 */

export enum SecurityErrorType {
	UNAUTHORIZED = 'UNAUTHORIZED',
	FORBIDDEN = 'FORBIDDEN',
	INVALID_TOKEN = 'INVALID_TOKEN',
	TOKEN_EXPIRED = 'TOKEN_EXPIRED',
	RATE_LIMITED = 'RATE_LIMITED',
	INVALID_INPUT = 'INVALID_INPUT',
	CSRF_VIOLATION = 'CSRF_VIOLATION',
	CONFLICT = 'CONFLICT',
}

export class SecurityError extends Error {
	constructor(
		public type: SecurityErrorType,
		message: string,
		public statusCode: number = 401,
	) {
		super(message);
		this.name = 'SecurityError';
	}
}
