/**
 * Port of JWTUtils (worker/utils/jwtUtils.ts). Unchanged secret-strength
 * validation and sign/verify logic (`jose`, identical on Node and
 * Cloudflare Workers).
 *
 * One decoupling, not a behavior change: the original's
 * `createAccessToken` convenience method read its expiry from
 * `SessionService.config.sessionTTL` -- a cross-service static import.
 * Here it takes `expiresInSeconds` as an explicit parameter instead, so
 * this package doesn't need to depend on session-creation code just to
 * sign a token. `SESSION_TTL_SECONDS` below is the same default value
 * (3 days) `AuthOrchestrator` passes when it calls this.
 */

import { jwtVerify, SignJWT } from 'jose';
import { SecurityError, SecurityErrorType } from './errors';

export const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;

export interface TokenPayload {
	sub: string;
	iat: number;
	exp: number;
	email: string;
	type: 'access' | 'refresh';
	jti?: string;
	sessionId: string;
}

export class JWTUtils {
	private static instance: JWTUtils | null = null;
	private jwtSecret: Uint8Array;
	private readonly algorithm = 'HS256';

	private constructor(jwtSecret: string) {
		this.validateJWTSecret(jwtSecret);
		this.jwtSecret = new TextEncoder().encode(jwtSecret);
	}

	static getInstance(jwtSecret: string): JWTUtils {
		if (!jwtSecret) {
			throw new Error('JWT_SECRET not configured');
		}
		if (!JWTUtils.instance) {
			JWTUtils.instance = new JWTUtils(jwtSecret);
		}
		return JWTUtils.instance;
	}

	/** Test-only: clears the singleton so a fresh secret can be installed. */
	static resetInstanceForTests(): void {
		JWTUtils.instance = null;
	}

	private validateJWTSecret(secret: string): void {
		if (secret.length < 32) {
			throw new Error('JWT_SECRET must be at least 32 characters long for security');
		}

		const weakSecrets = ['default', 'secret', 'password', 'changeme', 'admin', 'test'];
		if (weakSecrets.includes(secret.toLowerCase())) {
			throw new Error(
				'JWT_SECRET contains a weak/default value. Please use a cryptographically secure random string',
			);
		}

		const hasLowercase = /[a-z]/.test(secret);
		const hasUppercase = /[A-Z]/.test(secret);
		const hasNumbers = /[0-9]/.test(secret);
		const hasSpecial = /[^a-zA-Z0-9]/.test(secret);
		const characterTypes = [hasLowercase, hasUppercase, hasNumbers, hasSpecial].filter(Boolean).length;
		if (characterTypes < 3) {
			throw new Error('JWT_SECRET must contain at least 3 different character types');
		}

		if (/(.)\1{3,}/.test(secret)) {
			throw new Error('JWT_SECRET contains repetitive patterns');
		}
	}

	async signPayload(payload: Record<string, unknown>, expiresIn: number): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ ...payload })
			.setProtectedHeader({ alg: this.algorithm })
			.setIssuedAt(now)
			.setExpirationTime(now + expiresIn)
			.sign(this.jwtSecret);
	}

	async verifyPayload(token: string): Promise<Record<string, unknown> | null> {
		try {
			const { payload } = await jwtVerify(token, this.jwtSecret, { algorithms: [this.algorithm] });
			return payload as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	async createToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: number = 24 * 3600): Promise<string> {
		try {
			return await this.signPayload(payload as unknown as Record<string, unknown>, expiresIn);
		} catch (error) {
			throw new SecurityError(SecurityErrorType.INVALID_TOKEN, 'Failed to create token', 500);
		}
	}

	async verifyToken(token: string): Promise<TokenPayload | null> {
		const payload = await this.verifyPayload(token);
		if (!payload) return null;
		if (!payload.sub || !payload.email || !payload.type || !payload.exp || !payload.iat) {
			return null;
		}
		return {
			sub: payload.sub as string,
			email: payload.email as string,
			type: payload.type as 'access' | 'refresh',
			exp: payload.exp as number,
			iat: payload.iat as number,
			jti: payload.jti as string | undefined,
			sessionId: payload.sessionId as string,
		};
	}

	async createAccessToken(
		userId: string,
		email: string,
		sessionId: string,
		expiresInSeconds: number = SESSION_TTL_SECONDS,
	): Promise<{ accessToken: string; expiresIn: number }> {
		const payload = { sub: userId, email, sessionId };
		const accessToken = await this.createToken({ ...payload, type: 'access' as const }, expiresInSeconds);
		return { accessToken, expiresIn: expiresInSeconds };
	}

	async hashToken(token: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(token);
		const hash = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
		return btoa(String.fromCharCode(...new Uint8Array(hash)));
	}
}
