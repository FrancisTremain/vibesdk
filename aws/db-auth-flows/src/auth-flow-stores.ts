/**
 * DynamoDB storage primitives for the short-lived auth-flow state
 * `AuthService` manages (worker/database/services/AuthService.ts) --
 * OAuth CSRF state, login attempt tracking, password reset / email
 * verification tokens, OTPs. Against Table 3 (`vibesdk-auth-flows`) of
 * docs/aws-dynamodb-schema.md, designed there but not previously
 * validated against real code.
 *
 * This is deliberately scoped to storage primitives, not a port of
 * AuthService itself. AuthService's own methods (`register`, `login`,
 * `handleOAuthCallback`, etc.) are orchestration on top of these
 * primitives plus `PasswordService` (password hashing/verification,
 * not examined here) and OAuth provider HTTP clients
 * (`worker/services/oauth/`, not examined here) -- a materially
 * different, larger piece of work than "replace this class's storage
 * backend," which is what every other `aws/db-*` package in this repo
 * has been. Not rushed into; these primitives are what any actual
 * AuthService port would need underneath it regardless of how the
 * orchestration layer ends up shaped.
 *
 * Every item here gets a DynamoDB TTL attribute matching its
 * `expiresAt` (or, for auth attempts, a fixed window), replacing what
 * were D1 `expiresAtIdx` indexes plus an implicit cleanup job -- same
 * pattern as every other transient-state store in this migration
 * (`aws/rate-limit`, the session/lookup items in `aws/db-identity`).
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
	QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
	AttemptType,
	AuthAttempt,
	EmailVerificationToken,
	NewEmailVerificationToken,
	NewOAuthState,
	NewPasswordResetToken,
	NewVerificationOtp,
	OAuthState,
	PasswordResetToken,
	VerificationOtp,
} from './types';

/** Bounded recent-attempt window for lockout/rate-limit logic -- attempts
 *  older than this are TTL'd away, matching the schema doc's note that
 *  attempt-tracking reads a bounded recent window, not full history. */
const AUTH_ATTEMPT_TTL_SECONDS = 24 * 60 * 60;

function newId(): string {
	return crypto.randomUUID();
}
function toTtlSeconds(epochMs: number): number {
	return Math.floor(epochMs / 1000);
}
function stripKeys<T extends Record<string, unknown>>(item: T): Omit<T, 'pk' | 'sk' | 'ttl'> {
	const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = item;
	return rest;
}

export class OAuthStateStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async create(data: NewOAuthState): Promise<OAuthState> {
		const now = Date.now();
		const state: OAuthState = {
			...data,
			id: newId(),
			createdAt: data.createdAt ?? now,
			isUsed: data.isUsed ?? false,
		};
		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `OAUTHSTATE#${state.state}`,
					sk: 'STATE',
					...state,
					ttl: toTtlSeconds(state.expiresAt),
				},
			}),
		);
		return state;
	}

	async findByState(state: string): Promise<OAuthState | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: `OAUTHSTATE#${state}`, sk: 'STATE' },
			}),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as OAuthState;
	}

	/** Marks used and returns the (pre-update) record, or null if not
	 *  found, already used, or expired -- the three cases a caller
	 *  validating a CSRF state needs to distinguish before trusting it. */
	async validateAndConsume(state: string): Promise<OAuthState | null> {
		const record = await this.findByState(state);
		if (!record) return null;
		if (record.isUsed) return null;
		if (record.expiresAt <= Date.now()) return null;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: `OAUTHSTATE#${state}`, sk: 'STATE' },
				UpdateExpression: 'SET isUsed = :true',
				ExpressionAttributeValues: { ':true': true },
			}),
		);
		return record;
	}
}

export class AuthAttemptStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async record(attempt: Omit<AuthAttempt, 'attemptedAt'> & { attemptedAt?: number }): Promise<void> {
		const attemptedAt = attempt.attemptedAt ?? Date.now();
		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `AUTHATTEMPT#${attempt.identifier}`,
					sk: `ATTEMPT#${attemptedAt}#${newId()}`,
					...attempt,
					attemptedAt,
					ttl: toTtlSeconds(attemptedAt) + AUTH_ATTEMPT_TTL_SECONDS,
				},
			}),
		);
	}

	/** Attempts for `identifier` since `sinceMs`, most recent first -- the
	 *  shape lockout logic (`N failed attempts in the last M minutes`)
	 *  needs. Queries the whole (TTL-bounded, so naturally small) recent
	 *  partition and filters by timestamp client-side, rather than a
	 *  `sk >= :since` range condition -- the SK's `<epochMs>#<randomId>`
	 *  suffix makes a clean range boundary awkward, and this partition
	 *  never holds more than `AUTH_ATTEMPT_TTL_SECONDS` worth of attempts
	 *  for one identifier regardless. */
	async getRecentAttempts(identifier: string, sinceMs: number): Promise<AuthAttempt[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
				ExpressionAttributeValues: { ':pk': `AUTHATTEMPT#${identifier}`, ':prefix': 'ATTEMPT#' },
				ScanIndexForward: false,
			}),
		);
		const attempts = ((result.Items as Record<string, unknown>[] | undefined) ?? []).map(
			(i) => stripKeys(i) as unknown as AuthAttempt,
		);
		return attempts.filter((a) => a.attemptedAt >= sinceMs);
	}

	async countRecentFailures(identifier: string, sinceMs: number, type?: AttemptType): Promise<number> {
		const attempts = await this.getRecentAttempts(identifier, sinceMs);
		return attempts.filter((a) => !a.success && (!type || a.attemptType === type)).length;
	}
}

export class PasswordResetTokenStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async create(data: NewPasswordResetToken): Promise<PasswordResetToken> {
		const token: PasswordResetToken = {
			...data,
			id: newId(),
			createdAt: data.createdAt ?? Date.now(),
			used: data.used ?? false,
		};
		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `PWRESET#${token.tokenHash}`,
					sk: 'TOKEN',
					...token,
					ttl: toTtlSeconds(token.expiresAt),
				},
			}),
		);
		return token;
	}

	async findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: `PWRESET#${tokenHash}`, sk: 'TOKEN' },
			}),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as PasswordResetToken;
	}

	/** Returns true only if the token existed, was unused, and unexpired at
	 *  the time of the call -- callers should treat false as "reject the
	 *  reset attempt," not just "already marked." */
	async markUsed(tokenHash: string): Promise<boolean> {
		const token = await this.findByTokenHash(tokenHash);
		if (!token || token.used || token.expiresAt <= Date.now()) return false;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: `PWRESET#${tokenHash}`, sk: 'TOKEN' },
				UpdateExpression: 'SET used = :true',
				ExpressionAttributeValues: { ':true': true },
			}),
		);
		return true;
	}
}

export class EmailVerificationTokenStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async create(data: NewEmailVerificationToken): Promise<EmailVerificationToken> {
		const token: EmailVerificationToken = {
			...data,
			id: newId(),
			createdAt: data.createdAt ?? Date.now(),
			used: data.used ?? false,
		};
		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `EMAILVERIFY#${token.tokenHash}`,
					sk: 'TOKEN',
					...token,
					ttl: toTtlSeconds(token.expiresAt),
				},
			}),
		);
		return token;
	}

	async findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: `EMAILVERIFY#${tokenHash}`, sk: 'TOKEN' },
			}),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as EmailVerificationToken;
	}

	async markUsed(tokenHash: string): Promise<boolean> {
		const token = await this.findByTokenHash(tokenHash);
		if (!token || token.used || token.expiresAt <= Date.now()) return false;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: `EMAILVERIFY#${tokenHash}`, sk: 'TOKEN' },
				UpdateExpression: 'SET used = :true',
				ExpressionAttributeValues: { ':true': true },
			}),
		);
		return true;
	}
}

export class VerificationOtpStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async create(data: NewVerificationOtp): Promise<VerificationOtp> {
		const now = Date.now();
		const otp: VerificationOtp = {
			...data,
			id: newId(),
			createdAt: data.createdAt ?? now,
			used: data.used ?? false,
			usedAt: data.usedAt ?? null,
		};
		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `OTP#${otp.email}`,
					sk: `OTP#${otp.createdAt}`,
					...otp,
					ttl: toTtlSeconds(otp.expiresAt),
				},
			}),
		);
		return otp;
	}

	/** Most recently created unused, unexpired OTP for the email, or null. */
	async findLatestValidForEmail(email: string): Promise<VerificationOtp | null> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
				ExpressionAttributeValues: { ':pk': `OTP#${email}`, ':prefix': 'OTP#' },
			}),
		);
		const items = ((result.Items as Record<string, unknown>[] | undefined) ?? []).map(
			(i) => stripKeys(i) as unknown as VerificationOtp,
		);
		// Sorted client-side rather than relying on ScanIndexForward -- this
		// partition is naturally small (TTL-bounded, one email's OTPs), so
		// the extra sort is cheap and doesn't depend on Query's ordering
		// guarantee holding exactly as expected.
		const now = Date.now();
		return (
			items
				.filter((o) => !o.used && o.expiresAt > now)
				.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
		);
	}

	async markUsed(email: string, createdAt: number): Promise<boolean> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: `OTP#${email}`, sk: `OTP#${createdAt}` },
				UpdateExpression: 'SET used = :true, usedAt = :now',
				ExpressionAttributeValues: { ':true': true, ':now': Date.now() },
			}),
		);
		return true;
	}
}
