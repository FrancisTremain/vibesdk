/**
 * Port of GoogleOAuthProvider (worker/services/oauth/google.ts).
 * Unchanged logic.
 */

import { BaseOAuthProvider } from './base';
import type { Logger, OAuthUserInfo } from './types';

export class GoogleOAuthProvider extends BaseOAuthProvider {
	protected readonly provider = 'google';
	protected readonly authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
	protected readonly tokenUrl = 'https://oauth2.googleapis.com/token';
	protected readonly userInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';

	protected readonly scopes = ['openid', 'email', 'profile'];

	async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
		try {
			const response = await fetch(this.userInfoUrl, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			});

			if (!response.ok) {
				const error = await response.text();
				this.logger.error('Failed to get user info', { error });
				throw new Error(`Failed to get user info: ${error}`);
			}

			const data = (await response.json()) as {
				id: string;
				email: string;
				verified_email: boolean;
				name?: string;
				given_name?: string;
				family_name?: string;
				picture?: string;
				locale?: string;
			};

			return {
				id: data.id,
				email: data.email,
				name: data.name,
				picture: data.picture,
				emailVerified: data.verified_email,
			};
		} catch (error) {
			this.logger.error('Error getting user info', error);
			throw error;
		}
	}

	static create(
		clientId: string | undefined,
		clientSecret: string | undefined,
		baseUrl: string,
		logger?: Logger,
	): GoogleOAuthProvider {
		if (!clientId || !clientSecret) {
			throw new Error('Google OAuth credentials not configured');
		}
		const redirectUri = `${baseUrl}/api/auth/callback/google`;
		return new GoogleOAuthProvider(clientId, clientSecret, redirectUri, logger);
	}
}
