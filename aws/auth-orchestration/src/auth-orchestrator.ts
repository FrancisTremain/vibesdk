/**
 * Port of AuthService (worker/database/services/AuthService.ts, 1178
 * lines) -- register/login/logout, OAuth login + account-linking, email
 * verification, and token validation, assembled from every storage and
 * crypto primitive already ported in this migration:
 * `vibesdk-db-identity` (users, sessions, OAuth identities, API keys),
 * `vibesdk-db-auth-flows` (OAuth CSRF state, auth-attempt log,
 * verification OTPs), `vibesdk-auth-crypto` (password hashing +
 * strength validation), `vibesdk-oauth-clients` (GitHub/Google HTTP
 * clients).
 *
 * Three deliberate interface simplifications versus the original,
 * none of them behavior changes to the security-relevant logic:
 *
 * 1. No HTTP-cookie handling. The original reads the OAuth CSRF nonce
 *    cookie itself (`readOAuthNonceCookie(request, env)`), whose cookie
 *    name differs between dev and prod. This package has no HTTP layer
 *    of its own, so `handleOAuthCallback`/`completeOAuthLink` take the
 *    already-extracted cookie nonce value as a plain parameter instead
 *    -- the CSRF check itself (stored nonce must exist and match) is
 *    unchanged, just decoupled from cookie mechanics that belong to a
 *    caller's HTTP framework.
 * 2. `enforceAllowedEmail` takes the allowlist value as a constructor
 *    option instead of reading `env.ALLOWED_EMAIL` directly -- same
 *    gate, explicit dependency instead of an ambient Workers `Env`.
 * 3. `PasswordService`/OAuth-provider construction is done once in the
 *    constructor from injected credentials, instead of `Env`-typed
 *    `.create(env, baseUrl)` factories per call.
 *
 * NOT PORTED (same exclusions as the packages this assembles):
 * `logAuthAttempt`'s consumer, lockout enforcement using
 * `AuthAttemptStore.countRecentFailures`, was never wired up in the
 * original either (the store records attempts; nothing in AuthService
 * reads them back to lock an account) -- ported here exactly as
 * faithfully unused. Cloudflare OAuth (`CloudflareConnectOAuthProvider`)
 * is out of scope, same as `aws/oauth-clients`. `getPendingLinkUserId`
 * is ported since it's a pure read with no HTTP dependency.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
	ApiKeyStore,
	OAuthIdentityStore,
	SessionStore,
	UserStore,
	type NewUser,
	type OAuthIdentity,
	type User,
} from 'vibesdk-db-identity';
import {
	AuthAttemptStore,
	OAuthStateStore,
	VerificationOtpStore,
	type AttemptType,
} from 'vibesdk-db-auth-flows';
import { PasswordCrypto, validatePassword as validatePasswordStrength } from 'vibesdk-auth-crypto';
import { AuditLogStore } from 'vibesdk-db-audit';
import {
	BaseOAuthProvider,
	GitHubOAuthProvider,
	GoogleOAuthProvider,
	noopLogger,
	type Logger,
	type OAuthUserInfo,
} from 'vibesdk-oauth-clients';
import { SecurityError, SecurityErrorType } from './errors';
import { JWTUtils, SESSION_TTL_SECONDS } from './jwt';
import { enforceAllowedEmailCheck, extractRequestMetadata, mapUserResponse, validateEmail, validateRedirectUrl } from './auth-utils';
import type { AuthResult, AuthUser, AuthUserSession, LoginCredentials, OAuthProvider, RegistrationData } from './types';

export interface OAuthProviderCredentials {
	clientId: string;
	clientSecret: string;
}

export interface AuthOrchestratorConfig {
	ddb: DynamoDBDocumentClient;
	identityTable: string;
	authFlowsTable: string;
	/** Table 5 (`vibesdk-audit-log`). Optional: security-event logging
	 *  and `getUserSecurityStatus` are skipped (log calls become no-ops,
	 *  status reports zero events) if omitted, so existing callers that
	 *  don't care about audit logging aren't forced to provision it. */
	auditTable?: string;
	jwtSecret: string;
	allowedEmail?: string;
	oauth?: {
		google?: OAuthProviderCredentials;
		github?: OAuthProviderCredentials;
	};
	logger?: Logger;
}

/** Matches SessionService.config.maxConcurrentDevices from the original. */
const MAX_CONCURRENT_DEVICES = 3;

function generateSecureToken(length = 32): string {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class AuthOrchestrator {
	private readonly users: UserStore;
	private readonly apiKeys: ApiKeyStore;
	private readonly identities: OAuthIdentityStore;
	private readonly sessions: SessionStore;
	private readonly oauthStates: OAuthStateStore;
	private readonly attempts: AuthAttemptStore;
	private readonly otps: VerificationOtpStore;
	private readonly auditLog: AuditLogStore | null;
	private readonly passwordCrypto: PasswordCrypto;
	private readonly jwt: JWTUtils;
	private readonly allowedEmail?: string;
	private readonly oauthCredentials: AuthOrchestratorConfig['oauth'];
	private readonly logger: Logger;

	constructor(config: AuthOrchestratorConfig) {
		this.users = new UserStore(config.ddb, config.identityTable);
		this.apiKeys = new ApiKeyStore(config.ddb, config.identityTable);
		this.identities = new OAuthIdentityStore(config.ddb, config.identityTable);
		this.sessions = new SessionStore(config.ddb, config.identityTable);
		this.oauthStates = new OAuthStateStore(config.ddb, config.authFlowsTable);
		this.attempts = new AuthAttemptStore(config.ddb, config.authFlowsTable);
		this.otps = new VerificationOtpStore(config.ddb, config.authFlowsTable);
		this.auditLog = config.auditTable ? new AuditLogStore(config.ddb, config.auditTable) : null;
		this.passwordCrypto = new PasswordCrypto();
		this.jwt = JWTUtils.getInstance(config.jwtSecret);
		this.allowedEmail = config.allowedEmail;
		this.oauthCredentials = config.oauth;
		this.logger = config.logger ?? noopLogger;
	}

	// ========================================
	// EMAIL / PASSWORD
	// ========================================

	async register(data: RegistrationData, request: Request): Promise<AuthResult> {
		try {
			this.enforceAllowedEmail(data.email);

			const emailValidation = validateEmail(data.email);
			if (!emailValidation.valid) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, emailValidation.error || 'Invalid email format', 400);
			}

			const passwordValidation = validatePasswordStrength(data.password);
			if (!passwordValidation.valid) {
				throw new SecurityError(
					SecurityErrorType.INVALID_INPUT,
					(passwordValidation.errors ?? []).join(', '),
					400,
				);
			}

			const existing = await this.users.findUser({ email: data.email.toLowerCase() });
			if (existing) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Email already registered', 400);
			}

			const passwordHash = await this.passwordCrypto.hash(data.password);
			const userId = crypto.randomUUID();
			const email = data.email.toLowerCase();

			const newUser: NewUser = {
				email,
				username: null,
				displayName: data.name || email.split('@')[0]!,
				avatarUrl: null,
				bio: null,
				provider: 'email',
				providerId: userId,
				emailVerified: true,
				passwordHash,
				failedLoginAttempts: 0,
				lockedUntil: null,
				passwordChangedAt: null,
				preferences: '{}',
				theme: 'system',
				timezone: 'UTC',
				aiGatewayEnabled: null,
				isActive: true,
				isSuspended: false,
				lastActiveAt: null,
				deletedAt: null,
			};
			const user = await this.users.createUser(newUser, userId);

			await this.logAuthAttempt(data.email, 'register', true, request);

			const { accessToken, session } = await this.createSession(user.id, request);

			return {
				user: mapUserResponse(user),
				sessionId: session.id,
				expiresAt: new Date(session.expiresAt),
				accessToken,
			};
		} catch (error) {
			await this.logAuthAttempt(data.email, 'register', false, request);
			if (error instanceof SecurityError) throw error;
			this.logger.error('Registration error', error);
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Registration failed', 500);
		}
	}

	async login(credentials: LoginCredentials, request: Request): Promise<AuthResult> {
		try {
			this.enforceAllowedEmail(credentials.email);

			const user = await this.users.findUser({ email: credentials.email.toLowerCase() });
			if (!user || !user.passwordHash) {
				await this.logAuthAttempt(credentials.email, 'login', false, request);
				throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'Invalid email or password', 401);
			}

			const passwordValid = await this.passwordCrypto.verify(credentials.password, user.passwordHash);
			if (!passwordValid) {
				await this.logAuthAttempt(credentials.email, 'login', false, request);
				throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'Invalid email or password', 401);
			}

			const { accessToken, session } = await this.createSession(user.id, request);
			await this.logAuthAttempt(credentials.email, 'login', true, request);

			return {
				user: mapUserResponse(user),
				accessToken,
				sessionId: session.id,
				expiresAt: new Date(session.expiresAt),
			};
		} catch (error) {
			if (error instanceof SecurityError) throw error;
			this.logger.error('Login error', error);
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'Login failed', 500);
		}
	}

	async logout(sessionId: string): Promise<void> {
		try {
			await this.sessions.revokeSessionId(sessionId);
		} catch (error) {
			this.logger.error('Logout error', error);
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'Logout failed', 500);
		}
	}

	// ========================================
	// OAUTH LOGIN
	// ========================================

	getOauthProvider(provider: OAuthProvider, baseUrl: string): BaseOAuthProvider {
		const creds = this.oauthCredentials?.[provider];
		if (!creds) {
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, `OAuth provider ${provider} not configured`, 400);
		}
		if (provider === 'google') return GoogleOAuthProvider.create(creds.clientId, creds.clientSecret, baseUrl, this.logger);
		return GitHubOAuthProvider.create(creds.clientId, creds.clientSecret, baseUrl, this.logger);
	}

	async getOAuthAuthorizationUrl(
		provider: OAuthProvider,
		requestUrl: string,
		intendedRedirectUrl?: string,
		linkUserId?: string,
	): Promise<{ authUrl: string; nonce: string }> {
		const oauthProvider = this.getOauthProvider(provider, new URL(requestUrl).origin);

		let validatedRedirectUrl: string | null = null;
		if (intendedRedirectUrl) {
			validatedRedirectUrl = validateRedirectUrl(intendedRedirectUrl, requestUrl, this.logger);
		}

		const state = generateSecureToken();
		const codeVerifier = BaseOAuthProvider.generateCodeVerifier();
		const nonce = generateSecureToken();

		await this.oauthStates.create({
			state,
			provider,
			codeVerifier,
			redirectUri: validatedRedirectUrl ?? null,
			scopes: [],
			userId: linkUserId ?? null,
			nonce,
			expiresAt: Date.now() + 600_000, // 10 minutes
		});

		const authUrl = await oauthProvider.getAuthorizationUrl(state, codeVerifier);
		return { authUrl, nonce };
	}

	/** Whether a still-valid, unused state is bound to a user (account-link flow). Doesn't consume state. */
	async getPendingLinkUserId(state: string): Promise<string | null> {
		const row = await this.oauthStates.findByState(state);
		if (!row || row.isUsed) return null;
		return row.userId;
	}

	async handleOAuthCallback(
		provider: OAuthProvider,
		code: string,
		state: string,
		requestUrl: string,
		cookieNonce: string | null,
	): Promise<AuthResult> {
		try {
			const oauthProvider = this.getOauthProvider(provider, new URL(requestUrl).origin);
			const oauthState = await this.validateAndConsumeOAuthState(provider, state, cookieNonce);

			if (oauthState.userId) {
				throw new SecurityError(SecurityErrorType.CSRF_VIOLATION, 'Invalid OAuth state for login', 400);
			}

			const tokens = await oauthProvider.exchangeCodeForTokens(code, oauthState.codeVerifier || undefined);
			const oauthUserInfo = await oauthProvider.getUserInfo(tokens.accessToken);

			this.enforceAllowedEmail(oauthUserInfo.email);

			const user = await this.findOrCreateOAuthUser(provider, oauthUserInfo);
			const { accessToken, session } = await this.createSession(user.id, this.syntheticRequest(requestUrl));

			await this.logAuthAttemptByEmail(user.email, `oauth_${provider}`, true, requestUrl);

			return {
				user: mapUserResponse(user),
				accessToken,
				sessionId: session.id,
				expiresAt: new Date(session.expiresAt),
				redirectUrl: oauthState.redirectUri || undefined,
			};
		} catch (error) {
			await this.logAuthAttemptByEmail('', `oauth_${provider}`, false, requestUrl);
			if (error instanceof SecurityError) throw error;
			this.logger.error('OAuth callback error', error);
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'OAuth authentication failed', 500);
		}
	}

	/**
	 * Resolve the user for an OAuth login. An OAuth login authenticates a
	 * (provider, providerId) identity, NOT an email address -- lookup
	 * happens against the OAuth-identity table first. Binding an OAuth
	 * identity to an existing account only ever happens through the
	 * authenticated link flow (`linkOAuthIdentity`), never implicitly by
	 * email match -- that implicit bind is the account-takeover vector
	 * this method exists to close off.
	 */
	private async findOrCreateOAuthUser(provider: OAuthProvider, oauthUserInfo: OAuthUserInfo): Promise<User> {
		if (oauthUserInfo.emailVerified !== true) {
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'OAuth provider did not verify the email address', 401);
		}

		const email = oauthUserInfo.email.toLowerCase();

		const identity = await this.identities.findByProviderIdentity(provider, oauthUserInfo.id);
		if (identity) {
			await this.identities.refreshEmail(identity.userId, provider, oauthUserInfo.id, email, true);
			await this.users.updateUserProfile(identity.userId, {
				displayName: oauthUserInfo.name,
				avatarUrl: oauthUserInfo.picture,
			});
			const user = await this.users.findUser({ id: identity.userId });
			if (!user) throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'OAuth authentication failed', 500);
			return user;
		}

		const existingByEmail = await this.users.findUser({ email });
		if (existingByEmail) {
			throw new SecurityError(
				SecurityErrorType.CONFLICT,
				'An account with this email already exists. Sign in with your existing method, then link this provider from settings.',
				409,
			);
		}

		return this.createOAuthUser(provider, oauthUserInfo);
	}

	private async createOAuthUser(provider: OAuthProvider, oauthUserInfo: OAuthUserInfo): Promise<User> {
		const email = oauthUserInfo.email.toLowerCase();
		const newUser: NewUser = {
			email,
			username: null,
			displayName: oauthUserInfo.name || email.split('@')[0]!,
			avatarUrl: oauthUserInfo.picture ?? null,
			bio: null,
			provider,
			providerId: oauthUserInfo.id,
			emailVerified: true,
			passwordHash: null,
			failedLoginAttempts: 0,
			lockedUntil: null,
			passwordChangedAt: null,
			preferences: '{}',
			theme: 'system',
			timezone: 'UTC',
			aiGatewayEnabled: null,
			isActive: true,
			isSuspended: false,
			lastActiveAt: null,
			deletedAt: null,
		};
		const user = await this.users.createUser(newUser);
		await this.identities.link({
			userId: user.id,
			provider,
			providerId: oauthUserInfo.id,
			email,
			emailVerified: true,
		});
		return user;
	}

	// ========================================
	// OAUTH ACCOUNT LINKING
	// ========================================

	async completeOAuthLink(
		provider: OAuthProvider,
		code: string,
		state: string,
		requestUrl: string,
		cookieNonce: string | null,
		sessionUserId: string,
	): Promise<{ userId: string; provider: OAuthProvider; redirectUrl?: string }> {
		const oauthProvider = this.getOauthProvider(provider, new URL(requestUrl).origin);
		const oauthState = await this.validateAndConsumeOAuthState(provider, state, cookieNonce);

		if (!oauthState.userId || oauthState.userId !== sessionUserId) {
			throw new SecurityError(SecurityErrorType.CSRF_VIOLATION, 'Invalid account-link state', 403);
		}

		const tokens = await oauthProvider.exchangeCodeForTokens(code, oauthState.codeVerifier || undefined);
		const oauthUserInfo = await oauthProvider.getUserInfo(tokens.accessToken);

		await this.linkOAuthIdentity(oauthState.userId, provider, oauthUserInfo);

		return { userId: oauthState.userId, provider, redirectUrl: oauthState.redirectUri || undefined };
	}

	async linkOAuthIdentity(userId: string, provider: OAuthProvider, oauthUserInfo: OAuthUserInfo): Promise<void> {
		if (oauthUserInfo.emailVerified !== true) {
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, 'OAuth provider did not verify the email address', 401);
		}

		const email = oauthUserInfo.email.toLowerCase();
		const existing = await this.identities.findByProviderIdentity(provider, oauthUserInfo.id);

		if (existing) {
			if (existing.userId !== userId) {
				throw new SecurityError(SecurityErrorType.CONFLICT, 'This provider account is already linked to another user.', 409);
			}
			await this.identities.refreshEmail(userId, provider, oauthUserInfo.id, email, true);
			return;
		}

		await this.identities.link({ userId, provider, providerId: oauthUserInfo.id, email, emailVerified: true });
	}

	async getUserIdentities(userId: string): Promise<OAuthIdentity[]> {
		return this.identities.listForUser(userId);
	}

	/** Refuses to remove a user's only remaining login method (identity or password). */
	async unlinkOAuthIdentity(userId: string, provider: OAuthProvider): Promise<void> {
		const identities = await this.identities.listForUser(userId);
		const target = identities.find((i) => i.provider === provider);
		if (!target) {
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'No linked identity found for this provider.', 404);
		}

		const user = await this.users.findUser({ id: userId });
		const hasPassword = !!user?.passwordHash;
		const remainingIdentities = identities.length - 1;
		if (remainingIdentities < 1 && !hasPassword) {
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Cannot remove your only login method.', 400);
		}

		await this.identities.unlink(userId, provider, target.providerId);

		// If the removed identity was the primary one on the users row
		// (display/back-compat), repoint to another remaining identity so
		// the row stays coherent -- matches the original.
		if (user && user.provider === provider) {
			const next = identities.find((i) => i.provider !== provider);
			if (next) {
				await this.users.setPrimaryProvider(userId, next.provider, next.providerId);
			}
		}
	}

	// ========================================
	// EMAIL VERIFICATION (OTP)
	// ========================================

	private async generateAndStoreVerificationOtp(email: string): Promise<string> {
		const otp = Math.floor(100000 + Math.random() * 900000).toString();
		const expiresAt = Date.now() + 15 * 60 * 1000;
		await this.otps.create({
			email: email.toLowerCase(),
			otp: await this.passwordCrypto.hash(otp),
			expiresAt,
		});
		return otp;
	}

	async verifyEmailWithOtp(email: string, otp: string, request: Request): Promise<AuthResult> {
		try {
			this.enforceAllowedEmail(email);

			const stored = await this.otps.findLatestValidForEmail(email.toLowerCase());
			if (!stored) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Invalid or expired verification code', 400);
			}

			const otpValid = await this.passwordCrypto.verify(otp, stored.otp);
			if (!otpValid) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Invalid verification code', 400);
			}

			await this.otps.markUsed(stored.email, stored.createdAt);

			const user = await this.users.findUser({ email: email.toLowerCase() });
			if (!user) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'User not found', 404);
			}

			const { accessToken, session } = await this.createSession(user.id, request);
			await this.logAuthAttempt(email, 'login', true, request);

			return {
				user: mapUserResponse({ ...user, emailVerified: true }),
				accessToken,
				sessionId: session.id,
				expiresAt: new Date(session.expiresAt),
			};
		} catch (error) {
			await this.logAuthAttempt(email, 'login', false, request);
			if (error instanceof SecurityError) throw error;
			this.logger.error('Email verification error', error);
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Email verification failed', 500);
		}
	}

	async resendVerificationOtp(email: string): Promise<void> {
		try {
			const user = await this.users.findUser({ email: email.toLowerCase() });
			if (!user) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'No account found with this email', 404);
			}
			if (user.emailVerified) {
				throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Email is already verified', 400);
			}

			const existing = await this.otps.findLatestValidForEmail(email.toLowerCase());
			if (existing) {
				await this.otps.markUsed(existing.email, existing.createdAt);
			}

			await this.generateAndStoreVerificationOtp(email.toLowerCase());
		} catch (error) {
			if (error instanceof SecurityError) throw error;
			this.logger.error('Resend verification OTP error', error);
			throw new SecurityError(SecurityErrorType.INVALID_INPUT, 'Failed to resend verification code', 500);
		}
	}

	// ========================================
	// SECURITY EVENTS (SessionService.logSecurityEvent / getUserSecurityStatus)
	// ========================================

	/**
	 * Port of `SessionService.logSecurityEvent` -- writes to the
	 * `audit_logs` table (Table 5, `aws/db-audit`), not ported alongside
	 * the rest of `SessionService`'s storage layer in `aws/db-identity`
	 * because that table didn't exist yet. Never throws: a failure to
	 * log a security event shouldn't fail the request that triggered it,
	 * matching the original's catch-and-log-only behavior. No-ops if
	 * this orchestrator was constructed without `auditTable`.
	 */
	async logSecurityEvent(
		userId: string,
		sessionId: string,
		eventType: 'session_hijacking' | 'suspicious_activity' | 'device_change' | 'location_change',
		details: Record<string, unknown>,
		request?: Request,
	): Promise<void> {
		if (!this.auditLog) return;
		try {
			const metadata = request ? extractRequestMetadata(request) : { ipAddress: 'unknown', userAgent: 'unknown' };
			await this.auditLog.record({
				userId,
				entityType: 'session',
				entityId: sessionId,
				action: eventType,
				oldValues: null,
				newValues: details,
				ipAddress: metadata.ipAddress,
				userAgent: metadata.userAgent,
			});
		} catch (error) {
			this.logger.error('Failed to log security event', error);
		}
	}

	/**
	 * Port of `SessionService.getUserSecurityStatus`. Unchanged
	 * risk-scoring logic: active-session count above
	 * `MAX_CONCURRENT_DEVICES` bumps to medium risk, more than 5 recent
	 * (last 24h) security events bumps to high, more than 2 bumps to
	 * medium, and any `session_hijacking` event forces high regardless
	 * of count. Returns zeroed-out "low risk" status if this
	 * orchestrator was constructed without `auditTable` -- there's
	 * nothing to report on, not a real "everything is fine" signal.
	 */
	async getUserSecurityStatus(userId: string): Promise<{
		activeSessions: number;
		recentSecurityEvents: number;
		lastSecurityEvent?: Date;
		riskLevel: 'low' | 'medium' | 'high';
		recommendations: string[];
	}> {
		const activeSessionCount = (await this.sessions.getUserSessions(userId)).length;

		let recentEvents: Array<{ action: string; createdAt: number }> = [];
		if (this.auditLog) {
			const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
			recentEvents = (await this.auditLog.listForUser(userId, oneDayAgo)).filter(
				(e) => e.entityType === 'session',
			);
		}

		const recentSecurityEvents = recentEvents.length;
		const lastSecurityEvent = recentEvents[0] ? new Date(recentEvents[0].createdAt) : undefined;

		let riskLevel: 'low' | 'medium' | 'high' = 'low';
		const recommendations: string[] = [];

		if (activeSessionCount > MAX_CONCURRENT_DEVICES) {
			riskLevel = 'medium';
			recommendations.push('Consider revoking old sessions - you have many active sessions');
		}

		if (recentSecurityEvents > 5) {
			riskLevel = 'high';
			recommendations.push('Multiple security events detected - review your account activity');
		} else if (recentSecurityEvents > 2) {
			riskLevel = 'medium';
			recommendations.push('Some suspicious activity detected - monitor your account');
		}

		if (recentEvents.some((e) => e.action === 'session_hijacking')) {
			riskLevel = 'high';
			recommendations.push('Session hijacking attempts detected - change your password immediately');
		}

		if (recommendations.length === 0) {
			recommendations.push('Your account security looks good');
		}

		return { activeSessions: activeSessionCount, recentSecurityEvents, lastSecurityEvent, riskLevel, recommendations };
	}

	// ========================================
	// TOKEN / SESSION VALIDATION
	// ========================================

	async getUserForAuth(userId: string): Promise<AuthUser | null> {
		try {
			const user = await this.users.findUser({ id: userId });
			if (!user || user.deletedAt !== null || !user.isActive || user.isSuspended) return null;
			if (user.lockedUntil !== null && user.lockedUntil > Date.now()) return null;
			return mapUserResponse(user);
		} catch (error) {
			this.logger.error('Error getting user for auth', error);
			return null;
		}
	}

	/**
	 * Treats the JWT as a pointer, not a self-contained credential: every
	 * token is cross-checked against the live session / API key behind
	 * it, so logout, session revoke, and API-key revoke all take effect
	 * immediately rather than at token exp.
	 */
	async validateTokenAndGetUser(token: string): Promise<AuthUserSession | null> {
		try {
			const payload = await this.jwt.verifyToken(token);
			if (!payload || payload.type !== 'access') return null;
			if (payload.exp * 1000 < Date.now()) return null;
			if (!payload.sessionId) return null;

			if (payload.sessionId.startsWith('api_key:')) {
				const apiKeyId = payload.sessionId.slice('api_key:'.length);
				const apiKey = await this.apiKeys.getApiKeyById(apiKeyId);
				if (!apiKey || !apiKey.isActive) return null;
				if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) return null;
			} else {
				const session = await this.sessions.getSessionById(payload.sessionId);
				if (!session || session.isRevoked) return null;
				if (session.expiresAt && session.expiresAt < Date.now()) return null;
			}

			const user = await this.getUserForAuth(payload.sub);
			if (!user) return null;

			return { user, sessionId: payload.sessionId };
		} catch (error) {
			this.logger.error('Token validation error', error);
			return null;
		}
	}

	// ========================================
	// INTERNAL
	// ========================================

	private enforceAllowedEmail(email: string): void {
		const result = enforceAllowedEmailCheck(this.allowedEmail, email);
		if (!result.allowed) {
			throw new SecurityError(SecurityErrorType.UNAUTHORIZED, result.message!, 403);
		}
	}

	private async createSession(userId: string, request: Request): Promise<{ accessToken: string; session: { id: string; expiresAt: number } }> {
		await this.sessions.cleanupUserSessions(userId);

		const sessionId = crypto.randomUUID();
		const user = await this.users.findUser({ id: userId });
		const userEmail = user?.email ?? '';

		const { accessToken } = await this.jwt.createAccessToken(userId, userEmail, sessionId, SESSION_TTL_SECONDS);
		const accessTokenHash = await this.jwt.hashToken(accessToken);
		const metadata = extractRequestMetadata(request);
		const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;

		const created = await this.users.createSession(
			{
				userId,
				deviceInfo: metadata.userAgent,
				userAgent: metadata.userAgent,
				ipAddress: metadata.ipAddress,
				isRevoked: false,
				revokedAt: null,
				revokedReason: null,
				accessTokenHash,
				refreshTokenHash: '',
				expiresAt,
				lastActivity: Date.now(),
			},
			sessionId,
		);

		return { accessToken, session: { id: created.id, expiresAt: created.expiresAt } };
	}

	private async validateAndConsumeOAuthState(
		provider: OAuthProvider,
		state: string,
		cookieNonce: string | null,
	) {
		const oauthState = await this.oauthStates.findByState(state);
		if (!oauthState || oauthState.isUsed || oauthState.provider !== provider || oauthState.expiresAt < Date.now()) {
			throw new SecurityError(SecurityErrorType.CSRF_VIOLATION, 'Invalid or expired OAuth state', 400);
		}

		if (!oauthState.nonce || !cookieNonce || cookieNonce !== oauthState.nonce) {
			this.logger.error('OAuth callback nonce mismatch - possible login CSRF', {
				provider,
				hasStoredNonce: !!oauthState.nonce,
				hasCookieNonce: !!cookieNonce,
			});
			throw new SecurityError(SecurityErrorType.CSRF_VIOLATION, 'Invalid or expired OAuth state', 400);
		}

		const consumed = await this.oauthStates.validateAndConsume(state);
		if (!consumed) {
			throw new SecurityError(SecurityErrorType.CSRF_VIOLATION, 'Invalid or expired OAuth state', 400);
		}
		return consumed;
	}

	private async logAuthAttempt(identifier: string, attemptType: AttemptType, success: boolean, request: Request): Promise<void> {
		try {
			const metadata = extractRequestMetadata(request);
			await this.attempts.record({
				identifier: identifier.toLowerCase(),
				attemptType,
				success,
				ipAddress: metadata.ipAddress,
				userAgent: metadata.userAgent,
			});
		} catch (error) {
			this.logger.error('Failed to log auth attempt', error);
		}
	}

	private async logAuthAttemptByEmail(identifier: string, attemptType: AttemptType, success: boolean, requestUrl: string): Promise<void> {
		await this.logAuthAttempt(identifier, attemptType, success, this.syntheticRequest(requestUrl));
	}

	/** OAuth callback paths only have a URL, not full request headers, at
	 *  the point metadata would be extracted -- builds a minimal Request
	 *  so `extractRequestMetadata` has something to read (all fields fall
	 *  through to 'unknown', same as the original when headers are absent). */
	private syntheticRequest(url: string): Request {
		return new Request(url);
	}
}
