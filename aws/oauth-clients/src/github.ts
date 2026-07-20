/**
 * Port of GitHubOAuthProvider (worker/services/oauth/github.ts).
 * Unchanged logic, including the security-relevant email-verification
 * handling (always resolve via /user/emails rather than trusting
 * /user's unverified `email` field). `createGitHubHeaders`/
 * `extractGitHubErrorText` inlined from worker/utils/githubUtils.ts.
 */

import { BaseOAuthProvider } from './base';
import type { Logger, OAuthUserInfo } from './types';

function createGitHubHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `token ${accessToken}`,
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'vibesdk-oauth-clients/1.0',
	};
}

async function extractGitHubErrorText(response: Response): Promise<string> {
	try {
		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			const errorData = (await response.json()) as { message?: string; error?: string };
			return errorData.message || errorData.error || `HTTP ${response.status}`;
		}
		const errorText = await response.text();
		return errorText || `HTTP ${response.status}`;
	} catch {
		return `HTTP ${response.status}`;
	}
}

export class GitHubOAuthProvider extends BaseOAuthProvider {
	protected readonly provider = 'github';
	protected readonly authorizationUrl = 'https://github.com/login/oauth/authorize';
	protected readonly tokenUrl = 'https://github.com/login/oauth/access_token';
	protected readonly userInfoUrl = 'https://api.github.com/user';
	protected readonly emailsUrl = 'https://api.github.com/user/emails';

	protected readonly scopes = ['read:user', 'user:email'];

	async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
		try {
			const userResponse = await fetch(this.userInfoUrl, {
				headers: createGitHubHeaders(accessToken),
			});

			if (!userResponse.ok) {
				const error = await extractGitHubErrorText(userResponse);
				this.logger.error('Failed to get user info', {
					status: userResponse.status,
					error: error.substring(0, 200),
				});
				throw new Error('Failed to retrieve user information from GitHub');
			}

			const userData = (await userResponse.json()) as {
				id: number;
				login: string;
				email?: string;
				name?: string;
				avatar_url?: string;
			};

			const emailsResponse = await fetch(this.emailsUrl, {
				headers: createGitHubHeaders(accessToken),
			});

			let chosen: { email: string; verified: boolean } | undefined;
			if (emailsResponse.ok) {
				const emails = (await emailsResponse.json()) as Array<{
					email: string;
					verified: boolean;
					primary: boolean;
				}>;

				chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
			}

			const email = chosen?.email ?? userData.email;
			if (!email) {
				throw new Error('Could not retrieve user email from GitHub');
			}

			return {
				id: String(userData.id),
				email,
				name: userData.name || userData.login,
				picture: userData.avatar_url,
				emailVerified: chosen?.verified ?? false,
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
	): GitHubOAuthProvider {
		if (!clientId || !clientSecret) {
			throw new Error('GitHub OAuth credentials not configured');
		}
		const redirectUri = `${baseUrl}/api/auth/callback/github`;
		return new GitHubOAuthProvider(clientId, clientSecret, redirectUri, logger);
	}
}
