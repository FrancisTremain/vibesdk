export interface OAuthState {
	id: string;
	state: string;
	provider: string;
	redirectUri: string | null;
	scopes: string[];
	userId: string | null;
	codeVerifier: string | null;
	nonce: string | null;
	createdAt: number;
	expiresAt: number;
	isUsed: boolean;
}

export type NewOAuthState = Omit<OAuthState, 'id' | 'createdAt' | 'isUsed'> &
	Partial<Pick<OAuthState, 'createdAt' | 'isUsed'>>;

export type AttemptType =
	| 'login'
	| 'register'
	| 'oauth_google'
	| 'oauth_github'
	| 'oauth_cloudflare'
	| 'refresh'
	| 'reset_password';

export interface AuthAttempt {
	identifier: string;
	attemptType: AttemptType;
	success: boolean;
	ipAddress: string;
	userAgent: string | null;
	attemptedAt: number;
}

export interface PasswordResetToken {
	id: string;
	userId: string;
	tokenHash: string;
	expiresAt: number;
	used: boolean;
	createdAt: number;
}

export type NewPasswordResetToken = Omit<PasswordResetToken, 'id' | 'createdAt' | 'used'> &
	Partial<Pick<PasswordResetToken, 'createdAt' | 'used'>>;

export interface EmailVerificationToken {
	id: string;
	userId: string;
	tokenHash: string;
	email: string;
	expiresAt: number;
	used: boolean;
	createdAt: number;
}

export type NewEmailVerificationToken = Omit<EmailVerificationToken, 'id' | 'createdAt' | 'used'> &
	Partial<Pick<EmailVerificationToken, 'createdAt' | 'used'>>;

export interface VerificationOtp {
	id: string;
	email: string;
	otp: string;
	expiresAt: number;
	used: boolean;
	usedAt: number | null;
	createdAt: number;
}

export type NewVerificationOtp = Omit<VerificationOtp, 'id' | 'createdAt' | 'used' | 'usedAt'> &
	Partial<Pick<VerificationOtp, 'createdAt' | 'used' | 'usedAt'>>;
