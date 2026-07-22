/**
 * Commits generate_all's output to this session's real git history in
 * S3 (aws/git-storage's `S3FS` adapter + isomorphic-git), independent
 * of the sandbox task's own ephemeral filesystem. S3, not a real git
 * host (GitHub/GitLab) with a service account: session storage is
 * internal, on-the-critical-path state, and this migration's standing
 * constraint is AWS-only for exactly that category of dependency --
 * a third-party git host stays right for the existing, explicit,
 * user-initiated GitHub Export feature, not for storage every
 * generation depends on. See aws/git-storage's README for the S3
 * key/chunking scheme (a straight port of
 * worker/agents/git/fs-adapter.ts's SqliteFS).
 *
 * Best-effort, deliberately: unlike every other mutate-and-persist
 * path in this package (all-or-nothing), a failure here does not fail
 * generate_all as a whole -- see messages.ts's generate_all case. By
 * the time this runs, the sandbox task is already live with the
 * user's files; that side effect can't be rolled back, and a working
 * preview is more immediately valuable than the git history behind
 * it. Callers get the failure back as `gitCommitError` on the result
 * rather than it being silently swallowed.
 */

import { createS3FS, type S3FS } from 'vibesdk-git-storage';
import * as git from 'isomorphic-git';
import type { GeneratedFile } from './generation';

const AUTHOR = { name: 'vibesdk', email: 'vibesdk@localhost' };
const GIT_DIR = '/';

export interface CommitResult {
	commitSha: string;
}

export async function commitGeneratedFiles(
	sessionId: string,
	files: GeneratedFile[],
	message: string,
	fsOverride?: S3FS,
): Promise<CommitResult> {
	const bucket = process.env.GIT_STORAGE_BUCKET;
	if (!fsOverride && !bucket) throw new Error('GIT_STORAGE_BUCKET not configured');

	// createS3FS constructs its own S3Client internally rather than
	// taking one from this package -- see that function's doc comment
	// in aws/git-storage/src/s3-fs.ts for why that matters specifically
	// across a file: dependency boundary.
	const fs = fsOverride ?? createS3FS(bucket!, `sessions/${sessionId}/git/`);

	await git.init({ fs, dir: GIT_DIR, defaultBranch: 'main' });
	for (const file of files) {
		// S3FS.writeFile creates any missing ancestor directory markers
		// itself (see that package's ensureAncestorDirs) -- no separate
		// mkdir step needed here.
		await fs.promises.writeFile(file.filePath, file.fileContents);
		await git.add({ fs, dir: GIT_DIR, filepath: file.filePath });
	}

	const commitSha = await git.commit({ fs, dir: GIT_DIR, message, author: AUTHOR });
	return { commitSha };
}
