import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

// WORKSPACE_DIR is read at module load time, so it must be set before the
// dynamic import below -- a static top-level import would run before this
// test file's own top-level code, in file-declaration order.
let baseUrl: string;
let server: Server;
let workspaceDir: string;

beforeAll(async () => {
	workspaceDir = await mkdtemp(path.join(tmpdir(), 'sandbox-cp-test-'));
	process.env.WORKSPACE_DIR = workspaceDir;
	process.env.INSTANCE_ID = 'test-instance';
	const { createControlPlaneServer } = await import('./server');
	server = createControlPlaneServer();
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('expected TCP address');
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(workspaceDir, { recursive: true, force: true });
});

describe('sandbox control-plane server', () => {
	it('writes files and reads them back', async () => {
		const writeRes = await fetch(`${baseUrl}/files`, {
			method: 'POST',
			body: JSON.stringify({ files: [{ filePath: 'src/index.ts', fileContents: 'export const x = 1;' }] }),
		});
		expect(writeRes.status).toBe(200);
		const writeBody = (await writeRes.json()) as any;
		expect(writeBody.success).toBe(true);
		expect(writeBody.results).toEqual([{ file: 'src/index.ts', success: true }]);

		const readRes = await fetch(`${baseUrl}/files?path=src/index.ts`);
		expect(readRes.status).toBe(200);
		const readBody = (await readRes.json()) as any;
		expect(readBody.files).toEqual([{ filePath: 'src/index.ts', fileContents: 'export const x = 1;' }]);
	});

	it('lists all files when no path filter is given', async () => {
		await fetch(`${baseUrl}/files`, {
			method: 'POST',
			body: JSON.stringify({ files: [{ filePath: 'a.txt', fileContents: 'a' }, { filePath: 'b/c.txt', fileContents: 'c' }] }),
		});
		const res = await fetch(`${baseUrl}/files`);
		const body = (await res.json()) as any;
		const paths = body.files.map((f: { filePath: string }) => f.filePath).sort();
		expect(paths).toContain('a.txt');
		expect(paths).toContain(path.join('b', 'c.txt'));
	});

	it('reports a read error for a missing file without failing the whole request', async () => {
		const res = await fetch(`${baseUrl}/files?path=does-not-exist.txt`);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.files).toEqual([]);
		expect(body.errors).toHaveLength(1);
		expect(body.errors[0].file).toBe('does-not-exist.txt');
	});

	it('rejects a write that escapes the workspace directory', async () => {
		const res = await fetch(`${baseUrl}/files`, {
			method: 'POST',
			body: JSON.stringify({ files: [{ filePath: '../../etc/passwd', fileContents: 'pwned' }] }),
		});
		const body = (await res.json()) as any;
		expect(body.results[0].success).toBe(false);
		expect(body.results[0].error).toMatch(/escapes workspace/);
	});

	it('executes shell commands and captures output', async () => {
		const res = await fetch(`${baseUrl}/commands`, {
			method: 'POST',
			body: JSON.stringify({ commands: ['echo hello-from-sandbox'] }),
		});
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.results[0].success).toBe(true);
		expect(body.results[0].output).toContain('hello-from-sandbox');
	});

	it('reports a failed command without throwing', async () => {
		const res = await fetch(`${baseUrl}/commands`, {
			method: 'POST',
			body: JSON.stringify({ commands: ['exit 7'] }),
		});
		const body = (await res.json()) as any;
		expect(body.success).toBe(false);
		expect(body.results[0].success).toBe(false);
		expect(body.results[0].exitCode).toBe(7);
	});

	it('returns 501 for deploy (not implemented in this pass)', async () => {
		const res = await fetch(`${baseUrl}/deploy`, { method: 'POST', body: '{}' });
		expect(res.status).toBe(501);
		const body = (await res.json()) as any;
		expect(body.success).toBe(false);
	});

	it('returns 404 for unknown routes', async () => {
		const res = await fetch(`${baseUrl}/nope`);
		expect(res.status).toBe(404);
	});
});

describe('control-plane secret auth', () => {
	// Reuses the server from the outer describe block -- isAuthorized()
	// reads process.env.CONTROLPLANE_SECRET fresh on every request, so
	// toggling it per-test doesn't need a separate server/module instance.
	afterAll(() => {
		delete process.env.CONTROLPLANE_SECRET;
	});

	it('rejects requests with no secret header once a secret is configured', async () => {
		process.env.CONTROLPLANE_SECRET = 'test-secret-value';
		const res = await fetch(`${baseUrl}/files`);
		expect(res.status).toBe(403);
	});

	it('rejects requests with the wrong secret', async () => {
		process.env.CONTROLPLANE_SECRET = 'test-secret-value';
		const res = await fetch(`${baseUrl}/files`, { headers: { 'x-controlplane-secret': 'wrong' } });
		expect(res.status).toBe(403);
	});

	it('accepts requests with the correct secret', async () => {
		process.env.CONTROLPLANE_SECRET = 'test-secret-value';
		const res = await fetch(`${baseUrl}/files`, { headers: { 'x-controlplane-secret': 'test-secret-value' } });
		expect(res.status).toBe(200);
	});
});
