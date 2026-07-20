import { describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { FakeS3Client } from './fake-s3';
import { S3FS } from './s3-fs';

function makeFs(): { fs: S3FS; fake: FakeS3Client } {
	const fake = new FakeS3Client();
	const fs = new S3FS(fake as unknown as S3Client, 'test-bucket', 'sessions/s1/git/');
	return { fs, fake };
}

describe('writeFile / readFile', () => {
	it('round-trips a small text file', async () => {
		const { fs } = makeFs();
		await fs.writeFile('README.md', 'hello world');
		const data = await fs.readFile('README.md', { encoding: 'utf8' });
		expect(data).toBe('hello world');
	});

	it('round-trips binary data', async () => {
		const { fs } = makeFs();
		const bytes = new Uint8Array([0, 1, 2, 255, 254]);
		await fs.writeFile('blob.bin', bytes);
		const data = (await fs.readFile('blob.bin')) as Uint8Array;
		expect(Array.from(data)).toEqual(Array.from(bytes));
	});

	it('splits a large file across multiple chunks and reassembles it on read', async () => {
		const { fs, fake } = makeFs();
		// 3 chunks' worth, not aligned to the boundary.
		const size = 1800 * 1024 * 2 + 100;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i % 256;

		await fs.writeFile('big.bin', bytes);

		expect(fake.has('sessions/s1/git/big.bin/chunk-0')).toBe(true);
		expect(fake.has('sessions/s1/git/big.bin/chunk-1')).toBe(true);
		expect(fake.has('sessions/s1/git/big.bin/chunk-2')).toBe(true);

		const readBack = (await fs.readFile('big.bin')) as Uint8Array;
		expect(readBack.length).toBe(size);
		expect(Array.from(readBack)).toEqual(Array.from(bytes));
	});

	it('creates ancestor directory markers implicitly', async () => {
		const { fs } = makeFs();
		await fs.writeFile('src/lib/util.ts', 'export {};');

		expect((await fs.stat('src')).isDirectory()).toBe(true);
		expect((await fs.stat('src/lib')).isDirectory()).toBe(true);
		expect((await fs.stat('src/lib/util.ts')).isFile()).toBe(true);
	});

	it('overwriting a file replaces its old chunks, not appends to them', async () => {
		const { fs, fake } = makeFs();
		const size = 1800 * 1024 + 500; // 2 chunks
		await fs.writeFile('a.bin', new Uint8Array(size));
		expect(fake.has('sessions/s1/git/a.bin/chunk-1')).toBe(true);

		await fs.writeFile('a.bin', 'short now');
		expect(fake.has('sessions/s1/git/a.bin/chunk-1')).toBe(false);
		expect(await fs.readFile('a.bin', { encoding: 'utf8' })).toBe('short now');
	});

	it('throws ENOENT reading a path that does not exist', async () => {
		const { fs } = makeFs();
		await expect(fs.readFile('nope.txt')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('throws EISDIR reading a directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		await expect(fs.readFile('src')).rejects.toMatchObject({ code: 'EISDIR' });
	});

	it('throws EISDIR writing to a path that is a directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		await expect(fs.writeFile('src', 'x')).rejects.toMatchObject({
			code: 'EISDIR',
		});
	});
});

describe('unlink', () => {
	it('removes a file and all its chunks', async () => {
		const { fs, fake } = makeFs();
		const size = 1800 * 1024 + 10;
		await fs.writeFile('a.bin', new Uint8Array(size));
		await fs.unlink('a.bin');

		expect(fake.has('sessions/s1/git/a.bin/chunk-0')).toBe(false);
		expect(fake.has('sessions/s1/git/a.bin/chunk-1')).toBe(false);
		expect(await fs.exists('a.bin')).toBe(false);
	});

	it('throws ENOENT for a missing file', async () => {
		const { fs } = makeFs();
		await expect(fs.unlink('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('throws EPERM for a directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		await expect(fs.unlink('src')).rejects.toMatchObject({ code: 'EPERM' });
	});
});

describe('mkdir / rmdir', () => {
	it('creates a directory and stats it', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		const stat = await fs.stat('src');
		expect(stat.isDirectory()).toBe(true);
	});

	it('is a no-op creating an already-existing directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		await expect(fs.mkdir('src')).resolves.toBeUndefined();
	});

	it('throws EEXIST creating a directory over an existing file', async () => {
		const { fs } = makeFs();
		await fs.writeFile('src', 'not a directory');
		await expect(fs.mkdir('src')).rejects.toMatchObject({ code: 'EEXIST' });
	});

	it('throws ENOENT creating a directory whose parent does not exist', async () => {
		const { fs } = makeFs();
		await expect(fs.mkdir('a/b')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('removes an empty directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('src');
		await fs.rmdir('src');
		expect(await fs.exists('src')).toBe(false);
	});

	it('throws ENOTEMPTY removing a directory with a file in it', async () => {
		const { fs } = makeFs();
		await fs.writeFile('src/a.ts', 'x');
		await expect(fs.rmdir('src')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
	});

	it('throws ENOTDIR removing a file', async () => {
		const { fs } = makeFs();
		await fs.writeFile('a.txt', 'x');
		await expect(fs.rmdir('a.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
	});
});

describe('readdir', () => {
	it('lists immediate children only, files and directories both', async () => {
		const { fs } = makeFs();
		await fs.writeFile('src/index.ts', 'x');
		await fs.writeFile('src/lib/util.ts', 'x');
		await fs.writeFile('README.md', 'x');

		const rootEntries = (await fs.readdir('.')).sort();
		expect(rootEntries).toEqual(['README.md', 'src']);

		const srcEntries = (await fs.readdir('src')).sort();
		expect(srcEntries).toEqual(['index.ts', 'lib']);
	});

	it('returns an empty array for an empty directory', async () => {
		const { fs } = makeFs();
		await fs.mkdir('empty');
		expect(await fs.readdir('empty')).toEqual([]);
	});

	it('throws ENOENT for a missing path', async () => {
		const { fs } = makeFs();
		await expect(fs.readdir('nope')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('throws ENOTDIR for a file path', async () => {
		const { fs } = makeFs();
		await fs.writeFile('a.txt', 'x');
		await expect(fs.readdir('a.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
	});
});

describe('rename', () => {
	it('moves a file to a new path', async () => {
		const { fs } = makeFs();
		await fs.writeFile('old.txt', 'content');
		await fs.rename('old.txt', 'new.txt');

		expect(await fs.exists('old.txt')).toBe(false);
		expect(await fs.readFile('new.txt', { encoding: 'utf8' })).toBe('content');
	});

	it('moves every chunk of a multi-chunk file', async () => {
		const { fs, fake } = makeFs();
		const size = 1800 * 1024 + 42;
		await fs.writeFile('old.bin', new Uint8Array(size));
		await fs.rename('old.bin', 'new.bin');

		expect(fake.has('sessions/s1/git/old.bin/chunk-0')).toBe(false);
		expect(fake.has('sessions/s1/git/old.bin/chunk-1')).toBe(false);
		expect(fake.has('sessions/s1/git/new.bin/chunk-0')).toBe(true);
		expect(fake.has('sessions/s1/git/new.bin/chunk-1')).toBe(true);
	});

	it('throws ENOENT renaming a path that does not exist', async () => {
		const { fs } = makeFs();
		await expect(fs.rename('nope.txt', 'new.txt')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});

describe('symlink / readlink', () => {
	it('stores and reads back a symlink target as file content', async () => {
		const { fs } = makeFs();
		await fs.symlink('../refs/heads/main', 'HEAD');
		expect(await fs.readlink('HEAD')).toBe('../refs/heads/main');
	});
});

describe('exportGitObjects', () => {
	it('exports every file under .git/, reassembled', async () => {
		const { fs } = makeFs();
		await fs.writeFile('.git/HEAD', 'ref: refs/heads/main');
		await fs.writeFile('.git/refs/heads/main', 'abc123');
		await fs.writeFile('src/index.ts', 'not exported');

		const exported = await fs.exportGitObjects();
		const byPath = Object.fromEntries(
			exported.map((e) => [e.path, new TextDecoder().decode(e.data)]),
		);

		expect(Object.keys(byPath).sort()).toEqual([
			'.git/HEAD',
			'.git/refs/heads/main',
		]);
		expect(byPath['.git/HEAD']).toBe('ref: refs/heads/main');
		expect(byPath['.git/refs/heads/main']).toBe('abc123');
	});
});

describe('multi-tenancy via keyPrefix', () => {
	it('keeps two sessions fully isolated under the same bucket', async () => {
		const fake = new FakeS3Client();
		const fsA = new S3FS(fake as unknown as S3Client, 'bucket', 'sessions/a/git/');
		const fsB = new S3FS(fake as unknown as S3Client, 'bucket', 'sessions/b/git/');

		await fsA.writeFile('shared-name.txt', 'from A');
		await fsB.writeFile('shared-name.txt', 'from B');

		expect(await fsA.readFile('shared-name.txt', { encoding: 'utf8' })).toBe(
			'from A',
		);
		expect(await fsB.readFile('shared-name.txt', { encoding: 'utf8' })).toBe(
			'from B',
		);
	});
});
