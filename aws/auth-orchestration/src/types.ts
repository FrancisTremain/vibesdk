/**
 * Inlined from worker/types/auth-types.ts -- only the shapes
 * AuthOrchestrator's public methods actually use.
 */

export interface AuthUser {
	id: string;
	email: string;
	displayName?: string;
	username?: string;
	avatarUrl?: string;
	bio?: string;
	timezone?: string;
	provider?: string;
	emailVerified?: boolean;
	createdAt?: Date;
	isAnonymous?: boolean;
}

export interface AuthUserSession {
	user: AuthUser;
	sessionId: string;
}

export interface AuthResult {
	user: AuthUser;
	sessionId: string;
	expiresAt: Date | null;
	accessToken: string;
	redirectUrl?: string;
}

export type OAuthProvider = 'google' | 'github';

export interface OAuthUserInfo {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	emailVerified?: boolean;
}

export interface LoginCredentials {
	email: string;
	password: string;
}

export interface RegistrationData {
	email: string;
	password: string;
	name?: string;
}
