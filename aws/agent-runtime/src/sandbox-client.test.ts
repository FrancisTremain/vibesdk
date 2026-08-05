import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandboxInstance } from './sandbox-client';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	process.env.SANDBOX_ORCHESTRATOR_ENDPOINT = 'https://abc123.execute-api.ap-southeast-2.amazonaws.com';
	process.env.SANDBOX_ORCHESTRATOR_SECRET = 'orchestrator-secret';
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('createSandboxInstance', () => {
	it('posts to /api/sandbox/instances with the orchestrator secret header and a generated instanceId', async () => {
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://abc123.execute-api.ap-southeast-2.amazonaws.com/api/sandbox/instances');
			expect(init?.headers).toMatchObject({ 'x-orchestrator-secret': 'orchestrator-secret' });
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ projectName: 'demo', initCommand: 'bun run dev' });
			expect(typeof body.instanceId).toBe('string');
			expect(body.instanceId.length).toBeGreaterThan(0);
			return jsonResponse(200, { success: true, data: { runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' } });
		}) as unknown as typeof fetch;

		const result = await createSandboxInstance([{ filePath: 'a.txt', fileContents: 'x' }], 'demo', 'bun run dev', fetchImpl);

		expect(result).toMatchObject({ success: true, runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' });
	});

	it('throws when the orchestrator is not configured', async () => {
		delete process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
		delete process.env.SANDBOX_ORCHESTRATOR_SECRET;

		await expect(createSandboxInstance([], 'demo', 'bun run dev')).rejects.toThrow(/not configured/);
	});

	describe('when the synchronous POST fails (API Gateway\'s ~29s hard timeout outrunning a real creation)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		it('falls back to polling GET .../status and resolves once it reports ready', async () => {
			let postCalls = 0;
			let statusCalls = 0;
			const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') {
					postCalls++;
					return jsonResponse(503, {});
				}
				statusCalls++;
				expect(url.toString()).toMatch(/\/api\/sandbox\/instances\/[^/]+\/status$/);
				if (statusCalls < 2) {
					return jsonResponse(200, { success: true, data: { pending: true, isHealthy: false } });
				}
				return jsonResponse(200, {
					success: true,
					data: { pending: false, isHealthy: true, previewURL: 'http://1.2.3.4:3000', externalPreviewURL: 'https://inst-1.preview.test' },
				});
			}) as unknown as typeof fetch;

			const resultPromise = createSandboxInstance([], 'demo', 'bun run dev', fetchImpl);
			await vi.advanceTimersByTimeAsync(3_000);
			await vi.advanceTimersByTimeAsync(3_000);
			const result = await resultPromise;

			expect(postCalls).toBe(1);
			expect(statusCalls).toBe(2);
			expect(result).toMatchObject({
				success: true,
				previewURL: 'http://1.2.3.4:3000',
				externalPreviewURL: 'https://inst-1.preview.test',
			});
			expect(result.runId).toBeTruthy();
		});

		it('throws with the status error once the polled instance reports ERROR', async () => {
			const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') return jsonResponse(502, { success: false, error: { message: 'RunTask failed' } });
				return jsonResponse(200, { success: true, data: { pending: false, isHealthy: false, error: 'RunTask failed' } });
			}) as unknown as typeof fetch;

			const resultPromise = createSandboxInstance([], 'demo', 'bun run dev', fetchImpl);
			const assertion = expect(resultPromise).rejects.toThrow('RunTask failed');
			await vi.advanceTimersByTimeAsync(3_000);
			await assertion;
		});
	});
});
