/**
 * Repository-management subset of worker/services/github/GitHubService.ts,
 * ported to plain `fetch` against GitHub's REST API instead of
 * `@octokit/rest` -- same reasoning as aws/llm-client avoiding vendor
 * SDKs: fewer dependencies to bundle, and the REST surface used here
 * (create/get one repo) is small enough that a full SDK buys nothing.
 * Not ported: anything Octokit-specific beyond these three calls --
 * this package doesn't need the rest of GitHub's API surface.
 */

export interface GitHubRepository {
	html_url: string;
	clone_url: string;
	full_name: string;
	private: boolean;
}

export type CreateRepositoryResult =
	| { success: true; repository: GitHubRepository }
	| { success: false; error: string; alreadyExists?: boolean; repositoryName?: string };

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `token ${token}`,
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'vibesdk-github-export-lambda/1.0',
	};
}

export async function createUserRepository(
	options: { name: string; description?: string; private: boolean; token: string },
	fetchImpl: typeof fetch = fetch,
): Promise<CreateRepositoryResult> {
	const res = await fetchImpl('https://api.github.com/user/repos', {
		method: 'POST',
		headers: githubHeaders(options.token),
		body: JSON.stringify({
			name: options.name,
			description: options.description,
			private: options.private,
			auto_init: true,
		}),
	});

	if (res.ok) {
		const repository = (await res.json()) as GitHubRepository;
		return { success: true, repository };
	}

	const body = (await res.json().catch(() => ({}))) as {
		message?: string;
		errors?: { field?: string; message?: string }[];
	};

	if (res.status === 403) {
		return {
			success: false,
			error: 'GitHub OAuth token lacks required permissions to create a repository.',
		};
	}
	if (res.status === 422 && body.errors?.some((e) => e.field === 'name' && e.message?.includes('already exists'))) {
		return { success: false, error: `Repository '${options.name}' already exists on this account`, alreadyExists: true, repositoryName: options.name };
	}

	return { success: false, error: body.message ?? `GitHub repository creation failed (${res.status})` };
}

export async function getRepository(
	options: { owner: string; repo: string; token: string },
	fetchImpl: typeof fetch = fetch,
): Promise<{ success: boolean; repository?: GitHubRepository; error?: string }> {
	const res = await fetchImpl(`https://api.github.com/repos/${options.owner}/${options.repo}`, {
		headers: githubHeaders(options.token),
	});
	if (!res.ok) return { success: false, error: `Failed to fetch repository (${res.status})` };
	return { success: true, repository: (await res.json()) as GitHubRepository };
}

export async function repositoryExists(
	options: { repositoryUrl: string; token: string },
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const repoInfo = extractRepoInfo(options.repositoryUrl);
	if (!repoInfo) return false;
	const result = await getRepository({ ...repoInfo, token: options.token }, fetchImpl);
	return result.success;
}

/** Parses `owner/repo` out of an https:// or git@ GitHub URL. */
export function extractRepoInfo(url: string): { owner: string; repo: string } | null {
	try {
		const cleanUrl = url.startsWith('git@github.com:') ? url.replace('git@github.com:', 'https://github.com/') : url;
		const pathParts = new URL(cleanUrl).pathname.split('/').filter(Boolean);
		if (pathParts.length < 2) return null;
		return { owner: pathParts[0]!, repo: pathParts[1]!.replace(/\.git$/, '') };
	} catch {
		return null;
	}
}
