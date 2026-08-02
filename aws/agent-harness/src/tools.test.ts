import { describe, it, expect, vi } from 'vitest';
import { createHarnessToolDefinitions } from './tools';
import type { SandboxClient } from './sandbox-client';

// Each tool() call is generically typed to its own zod schema, so the array
// literal's element type collapses `.handler` to an intersection of every
// tool's argument shape when accessed generically -- cast to `any` here
// since each test calls a handler with args matching that specific tool.
function getHandler(definitions: ReturnType<typeof createHarnessToolDefinitions>, name: string): (args: any, extra: unknown) => Promise<{ content: { type: string; text: string }[] }> {
	const found = definitions.find((t) => t.name === name);
	if (!found) throw new Error(`tool ${name} not found`);
	return found.handler as any;
}

function fakeSandbox(overrides: Partial<SandboxClient> = {}): SandboxClient {
	return {
		writeFiles: vi.fn().mockResolvedValue({ success: true, results: [{ file: 'a.txt', success: true }] }),
		getFiles: vi.fn().mockResolvedValue({ success: true, files: [{ filePath: 'a.txt', fileContents: 'hi' }] }),
		executeCommands: vi.fn().mockResolvedValue({ success: true, results: [{ command: 'ls', success: true, output: 'a.txt' }] }),
		runStaticAnalysis: vi.fn().mockResolvedValue({
			success: true,
			lint: { issues: [], summary: { errorCount: 0, warningCount: 0, infoCount: 0 } },
			typecheck: { issues: [], summary: { errorCount: 0, warningCount: 0, infoCount: 0 }, rawOutput: '' },
		}),
		...overrides,
	} as unknown as SandboxClient;
}

describe('report_phase', () => {
	it('invokes onPhaseReport with the reported phase', async () => {
		const onPhaseReport = vi.fn();
		const definitions = createHarnessToolDefinitions({ sandbox: fakeSandbox(), onPhaseReport });
		const handler = getHandler(definitions, 'report_phase');

		await handler({ name: 'planning', status: 'started' }, undefined);

		expect(onPhaseReport).toHaveBeenCalledWith({ name: 'planning', status: 'started' });
	});
});

describe('write_file', () => {
	it('proxies to the sandbox client and summarizes the result', async () => {
		const sandbox = fakeSandbox();
		const definitions = createHarnessToolDefinitions({ sandbox, onPhaseReport: vi.fn() });
		const handler = getHandler(definitions, 'write_file');

		const result = await handler({ files: [{ filePath: 'a.txt', fileContents: 'hi' }] }, undefined);

		expect(sandbox.writeFiles).toHaveBeenCalledWith([{ filePath: 'a.txt', fileContents: 'hi' }], undefined);
		expect((result.content[0] as { text: string }).text).toContain('Wrote 1 file');
	});
});

describe('run_command', () => {
	it('proxies to the sandbox client and reports command output', async () => {
		const sandbox = fakeSandbox();
		const definitions = createHarnessToolDefinitions({ sandbox, onPhaseReport: vi.fn() });
		const handler = getHandler(definitions, 'run_command');

		const result = await handler({ commands: ['ls'] }, undefined);

		expect(sandbox.executeCommands).toHaveBeenCalledWith(['ls'], undefined);
		expect((result.content[0] as { text: string }).text).toContain('a.txt');
	});
});

describe('run_static_analysis', () => {
	it('proxies to the sandbox client and reports the typecheck summary', async () => {
		const sandbox = fakeSandbox();
		const definitions = createHarnessToolDefinitions({ sandbox, onPhaseReport: vi.fn() });
		const handler = getHandler(definitions, 'run_static_analysis');

		const result = await handler({}, undefined);

		expect(sandbox.runStaticAnalysis).toHaveBeenCalled();
		expect((result.content[0] as { text: string }).text).toContain('0 error(s)');
	});
});
