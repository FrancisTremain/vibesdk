import { describe, expect, it } from 'vitest';
import { createUserRepository, extractRepoInfo, getRepository, repositoryExists } from './github-repo-api';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('extractRepoInfo', () => {
	it('parses an https URL', () => {
		expect(extractRepoInfo('https://github.com/octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
	});
	it('parses an https URL with a .git suffix', () => {
		expect(extractRepoInfo('https://github.com/octocat/hello-world.git')).toEqual({ owner: 'octocat', repo: 'hello-world' });
	});
	it('parses a git@ SSH URL', () => {
		expect(extractRepoInfo('git@github.com:octocat/hello-world.git')).toEqual({ owner: 'octocat', repo: 'hello-world' });
	});
	it('returns null for a malformed URL', () => {
		expect(extractRepoInfo('not a url')).toBeNull();
		expect(extractRepoInfo('https://github.com/onlyowner')).toBeNull();
	});
});

describe('createUserRepository', () => {
	it('creates a repository and returns it on success', async () => {
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://api.github.com/user/repos');
			expect(init?.headers).toMatchObject({ Authorization: 'token tok' });
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ name: 'my-app', private: true, auto_init: true });
			return jsonResponse(201, { html_url: 'https://github.com/u/my-app', clone_url: 'https://github.com/u/my-app.git', full_name: 'u/my-app', private: true });
		}) as unknown as typeof fetch;

		const result = await createUserRepository({ name: 'my-app', private: true, token: 'tok' }, fetchImpl);
		expect(result).toEqual({ success: true, repository: { html_url: 'https://github.com/u/my-app', clone_url: 'https://github.com/u/my-app.git', full_name: 'u/my-app', private: true } });
	});

	it('reports alreadyExists on a 422 name-conflict response', async () => {
		const fetchImpl = (async () =>
			jsonResponse(422, { message: 'Validation Failed', errors: [{ field: 'name', message: 'name already exists on this account' }] })) as unknown as typeof fetch;

		const result = await createUserRepository({ name: 'my-app', private: false, token: 'tok' }, fetchImpl);
		expect(result).toEqual({ success: false, error: "Repository 'my-app' already exists on this account", alreadyExists: true, repositoryName: 'my-app' });
	});

	it('reports a clear permissions error on 403', async () => {
		const fetchImpl = (async () => jsonResponse(403, {})) as unknown as typeof fetch;
		const result = await createUserRepository({ name: 'my-app', private: false, token: 'tok' }, fetchImpl);
		expect(result.success).toBe(false);
		expect((result as { error: string }).error).toMatch(/lacks required permissions/);
	});
});

describe('getRepository', () => {
	it('fetches a repository by owner/repo', async () => {
		const fetchImpl = (async (url: string | URL) => {
			expect(url).toBe('https://api.github.com/repos/octocat/hello-world');
			return jsonResponse(200, { html_url: 'https://github.com/octocat/hello-world', clone_url: 'x', full_name: 'octocat/hello-world', private: false });
		}) as unknown as typeof fetch;

		const result = await getRepository({ owner: 'octocat', repo: 'hello-world', token: 'tok' }, fetchImpl);
		expect(result.success).toBe(true);
		expect(result.repository?.full_name).toBe('octocat/hello-world');
	});

	it('reports failure on a non-2xx response', async () => {
		const fetchImpl = (async () => jsonResponse(404, {})) as unknown as typeof fetch;
		const result = await getRepository({ owner: 'octocat', repo: 'nope', token: 'tok' }, fetchImpl);
		expect(result.success).toBe(false);
	});
});

describe('repositoryExists', () => {
	it('returns false for an unparseable URL without calling fetch', async () => {
		const fetchImpl = (async () => {
			throw new Error('should not be called');
		}) as unknown as typeof fetch;
		expect(await repositoryExists({ repositoryUrl: 'not a url', token: 'tok' }, fetchImpl)).toBe(false);
	});

	it('returns true when the repo lookup succeeds', async () => {
		const fetchImpl = (async () => jsonResponse(200, { html_url: 'x', clone_url: 'x', full_name: 'a/b', private: false })) as unknown as typeof fetch;
		expect(await repositoryExists({ repositoryUrl: 'https://github.com/a/b', token: 'tok' }, fetchImpl)).toBe(true);
	});
});
