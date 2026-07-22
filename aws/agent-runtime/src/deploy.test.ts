import { describe, expect, it } from 'vitest';
import { deployProject } from './deploy';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('deployProject', () => {
	it('creates an independent sandbox instance and returns its URL', async () => {
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			expect(init?.method).toBe('POST');
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ projectName: 'my-app', initCommand: 'bun run dev' });
			return jsonResponse(200, { success: true, data: { runId: 'deploy-inst-1', previewURL: 'http://5.6.7.8:3000' } });
		}) as unknown as typeof fetch;

		process.env.SANDBOX_ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example.com';
		process.env.SANDBOX_ORCHESTRATOR_SECRET = 'secret';

		const result = await deployProject([{ filePath: 'a.txt', fileContents: 'x' }], 'my-app', 'bun run dev', fetchImpl);
		expect(result).toEqual({ deployedUrl: 'http://5.6.7.8:3000', deploymentInstanceId: 'deploy-inst-1' });
	});

	it('throws when the sandbox response has no preview URL', async () => {
		const fetchImpl = (async () => jsonResponse(200, { success: true, data: {} })) as unknown as typeof fetch;
		process.env.SANDBOX_ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example.com';
		process.env.SANDBOX_ORCHESTRATOR_SECRET = 'secret';

		await expect(deployProject([{ filePath: 'a.txt', fileContents: 'x' }], 'my-app', 'bun run dev', fetchImpl)).rejects.toThrow(
			/did not return a preview URL/,
		);
	});
});
