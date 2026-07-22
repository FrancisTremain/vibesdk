/**
 * Pushes an aws/agent-runtime session's git history (already committed
 * to S3 by aws/agent-runtime's git-commit.ts, under the same
 * `sessions/<sessionId>/git/` key prefix) to a real GitHub repository,
 * over the real git smart-HTTP protocol via isomorphic-git -- port of
 * worker/services/github/GitHubService.ts's `pushViaGitProtocol`.
 *
 * Not ported from the original: the `GitCloneService.buildRepository`
 * step that reconstructs a fresh in-memory repo from raw git objects
 * plus template/blueprint metadata, and the README deploy-button
 * rewrite. Neither applies here -- the session's repo already exists
 * durably in S3 (this package pushes it as-is), and there's no
 * Cloudflare deploy button to rewrite on an AWS-hosted app.
 */

import * as isoGit from 'isomorphic-git';
import httpNode from 'isomorphic-git/http/node';
import { createS3FS, type S3FS } from 'vibesdk-git-storage';
import { extractRepoInfo } from './github-repo-api';

type GitApi = Pick<typeof isoGit, 'addRemote' | 'deleteRemote' | 'push' | 'resolveRef'>;
type HttpClient = typeof httpNode;

const defaultGit: GitApi = {
	addRemote: isoGit.addRemote,
	deleteRemote: isoGit.deleteRemote,
	push: isoGit.push,
	resolveRef: isoGit.resolveRef,
};

const PUSH_TIMEOUT_MS = 120_000;
const GIT_DIR = '/';
const REMOTE_NAME = 'github';

export interface PushResult {
	success: boolean;
	commitSha?: string;
	error?: string;
}

export interface PushDeps {
	fs?: S3FS;
	git?: GitApi;
	http?: HttpClient;
}

export async function pushSessionToGitHub(
	sessionId: string,
	repositoryUrl: string,
	token: string,
	deps: PushDeps = {},
): Promise<PushResult> {
	if (!extractRepoInfo(repositoryUrl)) {
		return { success: false, error: `Invalid repository URL: ${repositoryUrl}` };
	}

	const bucket = process.env.GIT_STORAGE_BUCKET;
	if (!deps.fs && !bucket) {
		return { success: false, error: 'GIT_STORAGE_BUCKET not configured' };
	}

	// createS3FS constructs its own S3Client internally -- see that
	// function's doc comment in aws/git-storage for why that matters
	// specifically across a file: dependency boundary.
	const fs = deps.fs ?? createS3FS(bucket!, `sessions/${sessionId}/git/`);
	const git = deps.git ?? defaultGit;
	const http = deps.http ?? httpNode;
	const gitUrl = repositoryUrl.endsWith('.git') ? repositoryUrl : `${repositoryUrl}.git`;

	try {
		// Remove any stale remote from a previous export attempt, then add
		// the current one fresh -- matches the original's "remove if
		// exists, then re-add" rather than trying to update in place.
		await git.deleteRemote({ fs, dir: GIT_DIR, remote: REMOTE_NAME }).catch(() => {});
		await git.addRemote({ fs, dir: GIT_DIR, remote: REMOTE_NAME, url: gitUrl });

		const pushPromise = git.push({
			fs,
			http,
			dir: GIT_DIR,
			remote: REMOTE_NAME,
			ref: 'main',
			force: true, // Allow non-fast-forward pushes -- this is a sync/export, not a collaborative merge.
			onAuth: () => ({ username: token, password: 'x-oauth-basic' }), // GitHub accepts a token as the HTTP Basic username.
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`Git push timed out after ${PUSH_TIMEOUT_MS}ms`)), PUSH_TIMEOUT_MS);
		});

		const pushResult = await Promise.race([pushPromise, timeoutPromise]);
		if (!pushResult.ok) {
			return { success: false, error: pushResult.error ?? 'Push failed' };
		}

		const commitSha = await git.resolveRef({ fs, dir: GIT_DIR, ref: 'HEAD' });
		return { success: true, commitSha };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
