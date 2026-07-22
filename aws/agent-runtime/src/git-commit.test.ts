import { describe, expect, it } from 'vitest';
import * as git from 'isomorphic-git';
import { createFakeS3FS } from 'vibesdk-git-storage';
import { commitGeneratedFiles } from './git-commit';

describe('commitGeneratedFiles', () => {
	it('writes files, commits them, and the commit is readable back from the same fs', async () => {
		const { fs } = createFakeS3FS('test-bucket', 'sessions/session-1/git/');

		const result = await commitGeneratedFiles(
			'session-1',
			[
				{ filePath: 'index.html', fileContents: '<h1>hi</h1>' },
				{ filePath: 'src/app.js', fileContents: 'console.log(1)' },
			],
			'Generate: demo-app',
			fs,
		);

		expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

		const log = await git.log({ fs, dir: '/', depth: 1 });
		expect(log[0]!.commit.message.trim()).toBe('Generate: demo-app');
		expect(log[0]!.commit.author.name).toBe('vibesdk');

		const committedFile = await git.readBlob({
			fs,
			dir: '/',
			oid: result.commitSha,
			filepath: 'src/app.js',
		});
		expect(new TextDecoder().decode(committedFile.blob)).toBe('console.log(1)');
	});

	it('produces two commits for two generations against the same session', async () => {
		const { fs } = createFakeS3FS('test-bucket', 'sessions/session-2/git/');

		await commitGeneratedFiles('session-2', [{ filePath: 'a.txt', fileContents: 'v1' }], 'first', fs);
		await commitGeneratedFiles('session-2', [{ filePath: 'a.txt', fileContents: 'v2' }], 'second', fs);

		const log = await git.log({ fs, dir: '/' });
		expect(log).toHaveLength(2);
		expect(log[0]!.commit.message.trim()).toBe('second');
		expect(log[1]!.commit.message.trim()).toBe('first');
	});

	it('throws when GIT_STORAGE_BUCKET is not configured and no fs override is given', async () => {
		const original = process.env.GIT_STORAGE_BUCKET;
		delete process.env.GIT_STORAGE_BUCKET;
		try {
			await expect(commitGeneratedFiles('session-3', [{ filePath: 'a.txt', fileContents: 'x' }], 'msg')).rejects.toThrow(
				/GIT_STORAGE_BUCKET/,
			);
		} finally {
			if (original !== undefined) process.env.GIT_STORAGE_BUCKET = original;
		}
	});
});
