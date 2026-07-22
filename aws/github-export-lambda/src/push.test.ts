import { describe, expect, it, vi } from 'vitest';
import { pushSessionToGitHub, type PushDeps } from './push';

function fakeGit(overrides: Partial<Record<'addRemote' | 'deleteRemote' | 'push' | 'resolveRef', unknown>> = {}) {
	return {
		addRemote: vi.fn(async () => {}),
		deleteRemote: vi.fn(async () => {}),
		push: vi.fn(async () => ({ ok: true })),
		resolveRef: vi.fn(async () => 'abc123'),
		...overrides,
	} as unknown as NonNullable<PushDeps['git']>;
}

describe('pushSessionToGitHub', () => {
	it('adds the remote and pushes to main, returning the resolved HEAD sha', async () => {
		const git = fakeGit();
		const fs = {} as unknown as NonNullable<PushDeps['fs']>;

		const result = await pushSessionToGitHub('session-1', 'https://github.com/octocat/demo', 'tok', { fs, git });

		expect(result).toEqual({ success: true, commitSha: 'abc123' });
		expect(git.addRemote).toHaveBeenCalledWith(expect.objectContaining({ remote: 'github', url: 'https://github.com/octocat/demo.git' }));
		const pushCall = (git.push as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(pushCall).toMatchObject({ remote: 'github', ref: 'main', force: true });
		expect(pushCall.onAuth()).toEqual({ username: 'tok', password: 'x-oauth-basic' });
	});

	it('does not add a .git suffix twice', async () => {
		const git = fakeGit();
		await pushSessionToGitHub('session-1', 'https://github.com/octocat/demo.git', 'tok', { fs: {} as never, git });
		expect(git.addRemote).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://github.com/octocat/demo.git' }));
	});

	it('returns a clear error for an invalid repository URL without touching git', async () => {
		const git = fakeGit();
		const result = await pushSessionToGitHub('session-1', 'not a url', 'tok', { fs: {} as never, git });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Invalid repository URL/);
		expect(git.addRemote).not.toHaveBeenCalled();
	});

	it('reports failure when the push itself fails', async () => {
		const git = fakeGit({ push: vi.fn(async () => ({ ok: false, error: 'remote rejected' })) });
		const result = await pushSessionToGitHub('session-1', 'https://github.com/octocat/demo', 'tok', { fs: {} as never, git });
		expect(result).toEqual({ success: false, error: 'remote rejected' });
	});

	it('catches a thrown error from the git layer', async () => {
		const git = fakeGit({ push: vi.fn(async () => { throw new Error('network down'); }) });
		const result = await pushSessionToGitHub('session-1', 'https://github.com/octocat/demo', 'tok', { fs: {} as never, git });
		expect(result).toEqual({ success: false, error: 'network down' });
	});

	it('errors when GIT_STORAGE_BUCKET is not configured and no fs override is given', async () => {
		const original = process.env.GIT_STORAGE_BUCKET;
		delete process.env.GIT_STORAGE_BUCKET;
		try {
			const result = await pushSessionToGitHub('session-1', 'https://github.com/octocat/demo', 'tok', { git: fakeGit() });
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/GIT_STORAGE_BUCKET/);
		} finally {
			if (original !== undefined) process.env.GIT_STORAGE_BUCKET = original;
		}
	});
});
