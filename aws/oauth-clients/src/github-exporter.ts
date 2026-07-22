/**
 * Port of GitHubExporterOAuthProvider (worker/services/oauth/github-exporter.ts).
 * Same shape as that file: a `GitHubOAuthProvider` subclass with wider
 * scopes (repo creation/push access instead of just sign-in identity)
 * and a slightly different `getUserInfo` (no /user/emails
 * verification round trip -- the exporter only needs a username to
 * attribute commits to, not a verified email for account linking).
 */

import { GitHubOAuthProvider } from './github';
import type { OAuthUserInfo } from './types';

function createGitHubHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `token ${accessToken}`,
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'vibesdk-oauth-clients/1.0',
	};
}

export class GitHubExporterOAuthProvider extends GitHubOAuthProvider {
	protected readonly scopes = ['public_repo', 'repo'];

	async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
		const userResponse = await fetch(this.userInfoUrl, { headers: createGitHubHeaders(accessToken) });
		if (!userResponse.ok) {
			throw new Error('Failed to retrieve user information from GitHub');
		}

		const userData = (await userResponse.json()) as {
			id: number;
			login: string;
			email?: string;
			name?: string;
			avatar_url?: string;
		};

		return {
			id: String(userData.id),
			email: userData.email || `${userData.login}@github.local`,
			name: userData.name || userData.login,
			picture: userData.avatar_url,
			emailVerified: true,
		};
	}
}
