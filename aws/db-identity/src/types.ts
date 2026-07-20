/**
 * Field shapes ported from worker/database/schema.ts's users/sessions/
 * api_keys tables (the slice UserService and ApiKeyService operate on).
 * Same fields as the Drizzle-inferred D1 types; storage model changes,
 * the shape of the data doesn't.
 */

export interface User {
	id: string;
	email: string;
	username: string | null;
	displayName: string;
	avatarUrl: string | null;
	bio: string | null;
	provider: string;
	providerId: string;
	emailVerified: boolean;
	passwordHash: string | null;
	failedLoginAttempts: number;
	lockedUntil: number | null;
	passwordChangedAt: number | null;
	preferences: string;
	theme: 'light' | 'dark' | 'system';
	timezone: string;
	aiGatewayEnabled: boolean | null;
	isActive: boolean;
	isSuspended: boolean;
	createdAt: number;
	updatedAt: number;
	lastActiveAt: number | null;
	deletedAt: number | null;
}

export type NewUser = Omit<User, 'id' | 'createdAt' | 'updatedAt'> &
	Partial<Pick<User, 'createdAt' | 'updatedAt'>>;

export interface Session {
	id: string;
	userId: string;
	deviceInfo: string | null;
	userAgent: string | null;
	ipAddress: string | null;
	isRevoked: boolean;
	revokedAt: number | null;
	revokedReason: string | null;
	accessTokenHash: string;
	refreshTokenHash: string;
	expiresAt: number;
	createdAt: number;
	lastActivity: number | null;
}

export type NewSession = Omit<Session, 'id' | 'createdAt'> &
	Partial<Pick<Session, 'createdAt'>>;

export interface ApiKey {
	id: string;
	userId: string;
	name: string;
	keyHash: string;
	keyPreview: string;
	scopes: string;
	isActive: boolean;
	lastUsed: number | null;
	requestCount: number;
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ApiKeyInfo {
	id: string;
	name: string;
	keyPreview: string;
	createdAt: number;
	lastUsed: number | null;
	isActive: boolean;
}

export interface CreateApiKeyData {
	userId: string;
	name: string;
	keyHash: string;
	keyPreview: string;
}
