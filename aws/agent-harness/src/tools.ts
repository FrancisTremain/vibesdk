/**
 * Custom tools registered in place of the Agent SDK's built-in
 * mutable tools (query() is created with `tools: []`, disabling
 * Bash/Write/Edit/Read/Glob/Grep entirely -- see ./session.ts). Every
 * file/command/analysis operation here proxies to the target
 * sandbox's aws/sandbox-controlplane server via ./sandbox-client.ts
 * instead of touching this container's own filesystem, which is why
 * the harness task can be a completely separate, disposable process
 * from the sandbox it's operating on.
 *
 * report_phase is the phase-progress signal: aws/harness-orchestrator-lambda's
 * GET .../status proxies to ./server.ts's /status route, which reports
 * whatever the most recent report_phase call set. No PostToolUse hook
 * needed -- the tool handler has direct closure access to the
 * session's phase state, so there's nothing a hook would add here.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxClient } from './sandbox-client';
import type { PhaseReport } from './session';

export interface HarnessToolsDeps {
	sandbox: SandboxClient;
	onPhaseReport: (phase: PhaseReport) => void;
}

/** The individual tool definitions, separate from the createSdkMcpServer wrapping below so tests can call each `.handler` directly without reaching into the live MCP server instance's internals. */
export function createHarnessToolDefinitions(deps: HarnessToolsDeps) {
	const writeFile = tool(
		'write_file',
		'Write one or more files into the generated project. Overwrites existing files at the given paths.',
		{
			files: z.array(z.object({ filePath: z.string(), fileContents: z.string() })).min(1),
			commitMessage: z.string().optional(),
		},
		async ({ files, commitMessage }) => {
			const result = await deps.sandbox.writeFiles(files, commitMessage);
			const failed = result.results.filter((r) => !r.success);
			const text = failed.length
				? `Wrote ${result.results.length - failed.length}/${result.results.length} files. Failures: ${failed.map((f) => `${f.file}: ${f.error}`).join('; ')}`
				: `Wrote ${result.results.length} file(s) successfully.`;
			return { content: [{ type: 'text', text }] };
		},
	);

	const readFile = tool(
		'read_file',
		'Read one or more files from the generated project by path.',
		{ filePaths: z.array(z.string()).min(1) },
		async ({ filePaths }) => {
			const result = await deps.sandbox.getFiles(filePaths);
			const text = result.files.map((f) => `--- ${f.filePath} ---\n${f.fileContents}`).join('\n\n');
			const errorNote = result.errors?.length ? `\n\nCould not read: ${result.errors.map((e) => `${e.file} (${e.error})`).join(', ')}` : '';
			return { content: [{ type: 'text', text: text + errorNote }] };
		},
	);

	const runCommand = tool(
		'run_command',
		'Run one or more shell commands inside the sandbox (e.g. package install, dev server start). Runs in the project root.',
		{ commands: z.array(z.string()).min(1), timeoutMs: z.number().optional() },
		async ({ commands, timeoutMs }) => {
			const result = await deps.sandbox.executeCommands(commands, timeoutMs);
			const text = result.results
				.map((r) => `$ ${r.command}\n${r.output}${r.error ? `\n[stderr] ${r.error}` : ''}${r.success ? '' : ` (exit ${r.exitCode})`}`)
				.join('\n\n');
			return { content: [{ type: 'text', text }] };
		},
	);

	const runStaticAnalysis = tool(
		'run_static_analysis',
		'Run lint and typecheck against the generated project and return the issues found.',
		{ lintFiles: z.array(z.string()).optional() },
		async ({ lintFiles }) => {
			const result = await deps.sandbox.runStaticAnalysis(lintFiles);
			const text = `Typecheck: ${result.typecheck.summary.errorCount} error(s), ${result.typecheck.summary.warningCount} warning(s)\n${result.typecheck.rawOutput}`;
			return { content: [{ type: 'text', text }] };
		},
	);

	const reportPhase = tool(
		'report_phase',
		'Report progress through the generation phases (e.g. planning, scaffold, implementation, done). Call with status "started" when beginning a phase and "completed" when it finishes. This is the only way phase progress reaches the user -- call it for every phase transition.',
		{ name: z.string(), status: z.enum(['started', 'completed']) },
		async ({ name, status }) => {
			deps.onPhaseReport({ name, status });
			return { content: [{ type: 'text', text: 'ok' }] };
		},
	);

	return [writeFile, readFile, runCommand, runStaticAnalysis, reportPhase];
}

export function createHarnessTools(deps: HarnessToolsDeps) {
	return createSdkMcpServer({
		name: 'harness',
		version: '0.0.1',
		tools: createHarnessToolDefinitions(deps),
	});
}
