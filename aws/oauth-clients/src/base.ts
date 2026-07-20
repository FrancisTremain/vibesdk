/**
 * Port of BaseOAuthProvider (worker/services/oauth/base.ts). Unchanged
 * logic -- pure `fetch`/`URLSearchParams`/Web Crypto, no Cloudflare
 * dependency in the original either. The only adaptations are the
 * logger (see types.ts) and dropping the Cloudflare-only
 * `OAuthClientAuthMethod` 'basic' path's one real caller
 * (cloudflare-connect.ts, not ported) -- kept the option itself since
 * it costs nothing and a future provider might need it.
 */

import { noopLogger, type Logger, type OAuthUserInfo } from './types';
import { base64url } from './crypto-utils';

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	tokenType: string;
}

export type OAuthClientAuthMethod = 'body' | 'basic';

interface RawTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
}

export abstract class BaseOAuthProvider {
	protected abstract readonly provider: string;
	protected abstract readonly authorizationUrl: string;
	protected abstract readonly tokenUrl: string;
	protected abstract readonly userInfoUrl: string;
	protected abstract readonly scopes: string[];
	protected readonly clientAuthMethod: OAuthClientAuthMethod = 'body';
	protected readonly logger: Logger;

	constructor(
		protected clientId: string,
		protected clientSecret: string,
		protected redirectUri: string,
		logger: Logger = noopLogger,
	) {
		this.logger = logger;
	}

	async getAuthorizationUrl(state: string, codeVerifier?: string): Promise<string> {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: 'code',
			scope: this.scopes.join(' '),
			state,
			access_type: 'offline',
			prompt: 'consent',
		});

		if (codeVerifier) {
			const challenge = await this.generateCodeChallenge(codeVerifier);
			params.append('code_challenge', challenge);
			params.append('code_challenge_method', 'S256');
		}

		return `${this.authorizationUrl}?${params.toString()}`;
	}

	protected async postTokenRequest(
		params: URLSearchParams,
		context: 'exchange' | 'refresh',
	): Promise<RawTokenResponse> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		};

		if (this.clientAuthMethod === 'basic') {
			headers.Authorization = `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`;
		} else {
			params.set('client_id', this.clientId);
			params.set('client_secret', this.clientSecret);
		}

		const response = await fetch(this.tokenUrl, {
			method: 'POST',
			headers,
			body: params.toString(),
		});

		if (!response.ok) {
			const error = await response.text();
			this.logger.error(`Token ${context} failed`, { provider: this.provider, error });
			throw new Error(`Token ${context} failed: ${error}`);
		}

		return (await response.json()) as RawTokenResponse;
	}

	async exchangeCodeForTokens(code: string, codeVerifier?: string): Promise<OAuthTokens> {
		try {
			const params = new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: this.redirectUri,
			});
			if (codeVerifier) params.append('code_verifier', codeVerifier);

			const data = await this.postTokenRequest(params, 'exchange');
			return {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresIn: data.expires_in,
				tokenType: data.token_type || 'Bearer',
			};
		} catch (error) {
			this.logger.error('Error exchanging code for tokens', error);
			throw error;
		}
	}

	abstract getUserInfo(accessToken: string): Promise<OAuthUserInfo>;

	async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
		try {
			const params = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			});
			const data = await this.postTokenRequest(params, 'refresh');
			return {
				accessToken: data.access_token,
				refreshToken: data.refresh_token || refreshToken,
				expiresIn: data.expires_in,
				tokenType: data.token_type || 'Bearer',
			};
		} catch (error) {
			this.logger.error('Error refreshing access token', error);
			throw error;
		}
	}

	protected async generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const hashBuffer = await crypto.subtle.digest(
			'SHA-256',
			encoder.encode(verifier) as Uint8Array<ArrayBuffer>,
		);
		return base64url(new Uint8Array(hashBuffer));
	}

	static generateCodeVerifier(): string {
		const length = 64;
		const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
		const maxUnbiased = Math.floor(256 / charset.length) * charset.length;
		const out = new Array<string>(length);
		const buf = new Uint8Array(1);
		for (let i = 0; i < length; i++) {
			let v: number;
			do {
				crypto.getRandomValues(buf);
				v = buf[0]!;
			} while (v >= maxUnbiased);
			out[i] = charset[v % charset.length]!;
		}
		return out.join('');
	}
}
