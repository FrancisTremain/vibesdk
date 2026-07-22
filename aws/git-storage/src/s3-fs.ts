/**
 * S3-only filesystem adapter for isomorphic-git.
 *
 * Port of worker/agents/git/fs-adapter.ts's SqliteFS onto S3, per
 * docs/aws-migration-technical-design.md decision 3. Same public
 * interface, same chunking scheme (1.8MB/chunk) — the storage backend
 * changes, the adapter's logic doesn't.
 *
 * Key scheme (per session, under `keyPrefix`):
 *   - A path's file content: `<keyPrefix><path>/chunk-<n>` (n = 0..N-1).
 *     Chunk 0 carries the file's total size as S3 object metadata
 *     (`total-size`), mirroring how the SQLite version put size on
 *     chunk_index 0 rather than deriving it from a single chunk's length
 *     (which is wrong for any file spanning more than one chunk).
 *   - A path's directory marker: `<keyPrefix><path>/.dirmeta` (empty
 *     body). Presence of this key is what makes a path a directory;
 *     presence of `chunk-0` is what makes it a file. The two are
 *     mutually exclusive by construction — every write path checks for
 *     the other before creating either.
 *   - The root path ('') is always treated as an existing directory
 *     without a real S3 object backing it — there's nothing to migrate
 *     off and no ENOENT case for it to hit.
 *
 * This gets `readdir` from S3's own hierarchy for free: listing
 * `<keyPrefix><path>/` with Delimiter '/' returns one level of children
 * as CommonPrefixes, whether that child is a file (its own `chunk-0`
 * key sits one level deeper) or a directory (its own `.dirmeta` key
 * does too) — no separate parent-path index needed, unlike the SQLite
 * version's `parent_path` column.
 *
 * Known parity gap, not a regression: `rename` here is exactly as
 * shallow as the SQLite version — it moves only the path's own chunks/
 * marker, not a directory's children. This matches today's actual
 * behavior (not a stated requirement), not a design goal; flagging it
 * so it isn't mistaken for an oversight.
 *
 * Known reserved-name assumption: `.dirmeta` and `chunk-<n>` are used
 * as path-segment markers. A real git tree path segment named exactly
 * `.dirmeta` would collide with this scheme. Considered acceptable for
 * this design (git repositories essentially never contain a file
 * literally named `.dirmeta`) but stated explicitly rather than left
 * implicit.
 */

import {
	S3Client,
	GetObjectCommand,
	PutObjectCommand,
	HeadObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	CopyObjectCommand,
	type _Object as S3Object,
} from '@aws-sdk/client-s3';

const CHUNK_SIZE = 1800 * 1024; // 1.8 MB, matches the SQLite adapter
const DIR_MARKER = '.dirmeta';

function normalizePath(path: string): string {
	const stripped = path.replace(/^\/+/, '');
	if (stripped === '.' || stripped === './') return '';
	return stripped.replace(/^\.\//, '').replace(/\/+$/, '');
}

function makeErrno(
	message: string,
	code: string,
	errno: number,
	path: string,
): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(message);
	err.code = code;
	err.errno = errno;
	err.path = path;
	return err;
}

function concatBuffers(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function streamToBytes(
	body: NodeJS.ReadableStream | ReadableStream | Blob | undefined,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array(0);
	// The Node.js AWS SDK v3 returns a Node.js Readable for GetObject bodies.
	const chunks: Buffer[] = [];
	for await (const chunk of body as NodeJS.ReadableStream) {
		chunks.push(chunk as Buffer);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

export interface Stat {
	type: 'file' | 'dir';
	mode: number;
	size: number;
	mtimeMs: number;
	dev: number;
	ino: number;
	uid: number;
	gid: number;
	ctime: Date;
	mtime: Date;
	ctimeMs: number;
	isFile: () => boolean;
	isDirectory: () => boolean;
	isSymbolicLink: () => boolean;
}

export class S3FS {
	public promises!: this;

	constructor(
		private readonly s3: S3Client,
		private readonly bucket: string,
		/** Per-session key namespace, e.g. `sessions/<sessionId>/git/`. Must end in '/'. */
		private readonly keyPrefix: string,
	) {
		if (!keyPrefix.endsWith('/')) {
			throw new Error("keyPrefix must end with '/'");
		}
		Object.defineProperty(this, 'promises', {
			value: this,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}

	private chunkKey(path: string, index: number): string {
		return `${this.keyPrefix}${path}/chunk-${index}`;
	}

	private dirKey(path: string): string {
		return `${this.keyPrefix}${path}/${DIR_MARKER}`;
	}

	private async headOrNull(key: string) {
		try {
			return await this.s3.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
			);
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	private async isDir(path: string): Promise<boolean> {
		if (path === '') return true;
		return (await this.headOrNull(this.dirKey(path))) !== null;
	}

	private async fileMeta(path: string) {
		return this.headOrNull(this.chunkKey(path, 0));
	}

	// ==========================================
	// Read
	// ==========================================

	async readFile(
		path: string,
		options?: { encoding?: 'utf8' },
	): Promise<Uint8Array | string> {
		const normalized = normalizePath(path);

		if (await this.isDir(normalized)) {
			throw makeErrno(
				`EISDIR: illegal operation on a directory, read '${path}'`,
				'EISDIR',
				-21,
				path,
			);
		}
		const chunk0Meta = await this.fileMeta(normalized);
		if (!chunk0Meta) {
			throw makeErrno(
				`ENOENT: no such file or directory, open '${path}'`,
				'ENOENT',
				-2,
				path,
			);
		}

		const chunkCount = chunkCountFromMetadata(chunk0Meta.Metadata);
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const obj = await this.s3.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: this.chunkKey(normalized, i),
				}),
			);
			chunks.push(await streamToBytes(obj.Body as never));
		}

		const result = concatBuffers(chunks);
		return options?.encoding === 'utf8'
			? new TextDecoder().decode(result)
			: result;
	}

	// ==========================================
	// Write
	// ==========================================

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized) throw new Error('Cannot write to root');

		if (await this.isDir(normalized)) {
			throw makeErrno(
				`EISDIR: illegal operation on a directory, open '${path}'`,
				'EISDIR',
				-21,
				path,
			);
		}

		const bytes =
			typeof data === 'string' ? new TextEncoder().encode(data) : data;

		await this.ensureAncestorDirs(normalized);
		await this.deleteAllChunks(normalized);

		const totalSize = bytes.length;
		const chunkCount = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

		for (let i = 0; i < chunkCount; i++) {
			const start = i * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, totalSize);
			await this.s3.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: this.chunkKey(normalized, i),
					Body: bytes.slice(start, end),
					...(i === 0
						? {
								Metadata: {
									'total-size': String(totalSize),
									'chunk-count': String(chunkCount),
								},
							}
						: {}),
				}),
			);
		}
	}

	private async ensureAncestorDirs(normalizedPath: string): Promise<void> {
		const parts = normalizedPath.split('/');
		for (let i = 0; i < parts.length - 1; i++) {
			const dirPath = parts.slice(0, i + 1).join('/');
			if (!(await this.isDir(dirPath))) {
				await this.s3.send(
					new PutObjectCommand({
						Bucket: this.bucket,
						Key: this.dirKey(dirPath),
						Body: new Uint8Array(0),
					}),
				);
			}
		}
	}

	private async deleteAllChunks(normalizedPath: string): Promise<void> {
		const keys = await this.listImmediateKeys(normalizedPath);
		const chunkKeys = keys.filter((k) => k.includes('/chunk-'));
		await this.deleteKeys(chunkKeys);
	}

	// ==========================================
	// Delete
	// ==========================================

	async unlink(path: string): Promise<void> {
		const normalized = normalizePath(path);

		if (await this.isDir(normalized)) {
			throw makeErrno(
				`EPERM: operation not permitted, unlink '${path}'`,
				'EPERM',
				-1,
				path,
			);
		}
		if (!(await this.fileMeta(normalized))) {
			throw makeErrno(
				`ENOENT: no such file or directory, unlink '${path}'`,
				'ENOENT',
				-2,
				path,
			);
		}

		await this.deleteAllChunks(normalized);
	}

	// ==========================================
	// Directory operations
	// ==========================================

	async readdir(path: string): Promise<string[]> {
		const normalized = normalizePath(path);

		if (!(await this.isDir(normalized))) {
			const exists = normalized === '' || (await this.fileMeta(normalized));
			throw exists
				? makeErrno(
						`ENOTDIR: not a directory, scandir '${path}'`,
						'ENOTDIR',
						-20,
						path,
					)
				: makeErrno(
						`ENOENT: no such file or directory, scandir '${path}'`,
						'ENOENT',
						-2,
						path,
					);
		}

		const prefix = normalized === '' ? this.keyPrefix : `${this.keyPrefix}${normalized}/`;
		const children = new Set<string>();
		let continuationToken: string | undefined;

		do {
			const page = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					Delimiter: '/',
					ContinuationToken: continuationToken,
				}),
			);
			for (const cp of page.CommonPrefixes ?? []) {
				if (!cp.Prefix) continue;
				const trimmed = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
				if (trimmed) children.add(trimmed);
			}
			continuationToken = page.IsTruncated
				? page.NextContinuationToken
				: undefined;
		} while (continuationToken);

		return Array.from(children);
	}

	async mkdir(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized) return;

		const parts = normalized.split('/');
		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join('/');
			if (!(await this.isDir(parentPath))) {
				throw makeErrno(
					`ENOENT: no such file or directory, mkdir '${path}'`,
					'ENOENT',
					-2,
					path,
				);
			}
		}

		if (await this.isDir(normalized)) return; // already exists
		if (await this.fileMeta(normalized)) {
			throw makeErrno(
				`EEXIST: file already exists, mkdir '${path}'`,
				'EEXIST',
				-17,
				path,
			);
		}

		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: this.dirKey(normalized),
				Body: new Uint8Array(0),
			}),
		);
	}

	async rmdir(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized) throw new Error('Cannot remove root directory');

		if (!(await this.isDir(normalized))) {
			const exists = await this.fileMeta(normalized);
			throw exists
				? makeErrno(
						`ENOTDIR: not a directory, rmdir '${path}'`,
						'ENOTDIR',
						-20,
						path,
					)
				: makeErrno(
						`ENOENT: no such file or directory, rmdir '${path}'`,
						'ENOENT',
						-2,
						path,
					);
		}

		const page = await this.s3.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: `${this.keyPrefix}${normalized}/`,
				MaxKeys: 2,
			}),
		);
		const hasChildren = (page.Contents ?? []).some(
			(o) => o.Key !== this.dirKey(normalized),
		);
		if (hasChildren) {
			throw makeErrno(
				`ENOTEMPTY: directory not empty, rmdir '${path}'`,
				'ENOTEMPTY',
				-39,
				path,
			);
		}

		await this.deleteKeys([this.dirKey(normalized)]);
	}

	// ==========================================
	// Stat
	// ==========================================

	async stat(path: string): Promise<Stat> {
		const normalized = normalizePath(path);

		if (await this.isDir(normalized)) {
			return this.buildStat('dir', 0, Date.now());
		}

		const chunk0Meta = await this.fileMeta(normalized);
		if (!chunk0Meta) {
			throw makeErrno(
				`ENOENT: no such file or directory, stat '${path}'`,
				'ENOENT',
				-2,
				path,
			);
		}

		const size = Number(chunk0Meta.Metadata?.['total-size'] ?? 0);
		const mtimeMs = chunk0Meta.LastModified?.getTime() ?? Date.now();
		return this.buildStat('file', size, mtimeMs);
	}

	async lstat(path: string): Promise<Stat> {
		return this.stat(path);
	}

	private buildStat(type: 'file' | 'dir', size: number, mtimeMs: number): Stat {
		const isDir = type === 'dir';
		return {
			type,
			mode: isDir ? 0o040755 : 0o100644,
			size,
			mtimeMs,
			dev: 0,
			ino: 0,
			uid: 0,
			gid: 0,
			ctime: new Date(mtimeMs),
			mtime: new Date(mtimeMs),
			ctimeMs: mtimeMs,
			isFile: () => !isDir,
			isDirectory: () => isDir,
			isSymbolicLink: () => false,
		};
	}

	// ==========================================
	// Symlink (used by git for refs)
	// ==========================================

	async symlink(target: string, path: string): Promise<void> {
		await this.writeFile(path, target);
	}

	async readlink(path: string): Promise<string> {
		return (await this.readFile(path, { encoding: 'utf8' })) as string;
	}

	// ==========================================
	// chmod / rename
	// ==========================================

	async chmod(): Promise<void> {
		// No-op: this adapter doesn't track file modes, matching the
		// SQLite version.
	}

	/**
	 * Shallow rename, matching the SQLite adapter's actual behavior: moves
	 * only oldPath's own chunks/marker, not a directory's children. See
	 * the module-level doc comment.
	 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldNorm = normalizePath(oldPath);
		const newNorm = normalizePath(newPath);

		const oldKeys = await this.listImmediateKeys(oldNorm);
		if (oldKeys.length === 0) {
			throw makeErrno(
				`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`,
				'ENOENT',
				-2,
				oldPath,
			);
		}

		const oldPrefix = `${this.keyPrefix}${oldNorm}/`;
		const newPrefix = `${this.keyPrefix}${newNorm}/`;

		for (const key of oldKeys) {
			const suffix = key.slice(oldPrefix.length);
			await this.s3.send(
				new CopyObjectCommand({
					Bucket: this.bucket,
					CopySource: `${this.bucket}/${encodeURIComponent(key)}`,
					Key: `${newPrefix}${suffix}`,
				}),
			);
		}

		await this.deleteKeys(oldKeys);
	}

	/** Keys directly under `path/` (chunk-N and/or .dirmeta), not deeper descendants. */
	private async listImmediateKeys(path: string): Promise<string[]> {
		const prefix = `${this.keyPrefix}${path}/`;
		const keys: string[] = [];
		let continuationToken: string | undefined;

		do {
			const page = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);
			for (const obj of page.Contents ?? []) {
				if (!obj.Key) continue;
				const suffix = obj.Key.slice(prefix.length);
				if (!suffix.includes('/')) keys.push(obj.Key);
			}
			continuationToken = page.IsTruncated
				? page.NextContinuationToken
				: undefined;
		} while (continuationToken);

		return keys;
	}

	private async deleteKeys(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		// DeleteObjects caps at 1000 keys/request; a single file's chunk
		// count will never realistically approach that.
		await this.s3.send(
			new DeleteObjectsCommand({
				Bucket: this.bucket,
				Delete: { Objects: keys.map((Key) => ({ Key })) },
			}),
		);
	}

	// ==========================================
	// Utilities
	// ==========================================

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw err;
		}
	}

	async write(path: string, data: Uint8Array | string): Promise<void> {
		return this.writeFile(path, data);
	}

	// ==========================================
	// Export (for git clone protocol)
	// ==========================================

	async exportGitObjects(): Promise<Array<{ path: string; data: Uint8Array }>> {
		const prefix = `${this.keyPrefix}.git/`;
		const exported: Array<{ path: string; data: Uint8Array }> = [];
		let continuationToken: string | undefined;
		const filePaths = new Set<string>();

		do {
			const page = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);
			for (const obj of page.Contents ?? []) {
				if (obj.Key?.endsWith('/chunk-0')) {
					const filePath = obj.Key.slice(
						this.keyPrefix.length,
						-'/chunk-0'.length,
					);
					filePaths.add(filePath);
				}
			}
			continuationToken = page.IsTruncated
				? page.NextContinuationToken
				: undefined;
		} while (continuationToken);

		for (const filePath of filePaths) {
			const data = await this.readFile(filePath);
			exported.push({ path: filePath, data: data as Uint8Array });
		}

		return exported;
	}
}

function isNotFound(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const name = (err as { name?: string }).name;
	return name === 'NotFound' || name === 'NoSuchKey';
}

function chunkCountFromMetadata(
	metadata: Record<string, string> | undefined,
): number {
	const fromCount = metadata?.['chunk-count'];
	return fromCount ? Number(fromCount) : 1;
}

export type { S3Object };

/**
 * Convenience factory for consumers outside this package: constructs
 * an `S3Client` internally rather than requiring the caller to import
 * `@aws-sdk/client-s3` themselves and pass one in. That matters across
 * a `file:` dependency boundary specifically -- a consumer's own
 * separately-installed `node_modules/@aws-sdk/client-s3` produces a
 * structurally-identical but nominally distinct `S3Client` type from
 * this package's copy, which TypeScript then rejects at the `S3FS`
 * constructor. Calling `createS3FS` instead of `new S3FS(new
 * S3Client(...), ...)` avoids that entirely -- the `S3Client` never
 * crosses the package boundary. Pass `s3Client` explicitly only from
 * within this package's own tests/fakes.
 */
export function createS3FS(bucket: string, keyPrefix: string, s3Client?: S3Client): S3FS {
	return new S3FS(s3Client ?? new S3Client({}), bucket, keyPrefix);
}
