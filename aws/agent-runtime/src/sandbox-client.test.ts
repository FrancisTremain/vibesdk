import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandboxInstance } from './sandbox-client';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	process.env.SANDBOX_ORCHESTRATOR_ENDPOINT = 'https://abc123.execute-api.ap-southeast-2.amazonaws.com';
	process.env.SANDBOX_ORCHESTRATOR_SECRET = 'orchestrator-secret';
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('createSandboxInstance', () => {
	it('posts to /api/sandbox/instances with the orchestrator secret header', async () => {
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://abc123.execute-api.ap-southeast-2.amazonaws.com/api/sandbox/instances');
			expect(init?.headers).toMatchObject({ 'x-orchestrator-secret': 'orchestrator-secret' });
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ projectName: 'demo', initCommand: 'bun run dev' });
			return jsonResponse(200, { success: true, data: { runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' } });
		}) as unknown as typeof fetch;

		const result = await createSandboxInstance([{ filePath: 'a.txt', fileContents: 'x' }], 'demo', 'bun run dev', fetchImpl);

		expect(result).toMatchObject({ success: true, runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' });
	});

	it('throws with the orchestrator error message on failure', async () => {
		const fetchImpl = (async () => jsonResponse(502, { success: false, error: { message: 'RunTask failed' } })) as unknown as typeof fetch;

		await expect(createSandboxInstance([], 'demo', 'bun run dev', fetchImpl)).rejects.toThrow('RunTask failed');
	});

	it('throws when the orchestrator is not configured', async () => {
		delete process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
		delete process.env.SANDBOX_ORCHESTRATOR_SECRET;

		await expect(createSandboxInstance([], 'demo', 'bun run dev')).rejects.toThrow(/not configured/);
	});
});
