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
 *
 * onEvent is the real-time push signal, separate from onPhaseReport's
 * poll-friendly local state: every tool below also calls it so a
 * caller wired to push these out immediately (see ./session.ts's
 * eventsEndpoint) gets live feedback as the harness works, not just
 * the coarse phase/done shape GET /status exposes. Each tool emits a
 * pre- and post-event where the frontend has a matching pair
 * (generating/generated, executing/executed) -- matching worker/api/websocketTypes.ts's
 * existing cases exactly, so the frontend needs no changes to consume
 * any of these.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxClient, StaticAnalysisResult, RuntimeError } from './sandbox-client';
import type { PhaseReport } from './session';

export type HarnessEvent =
	| { type: 'file_generating'; filePath: string; filePurpose: string }
	| { type: 'file_regenerating'; filePath: string; original_issues?: string }
	| { type: 'file_generated'; file: { filePath: string; fileContents: string; filePurpose: string } }
	| { type: 'file_regenerated'; file: { filePath: string; fileContents: string; filePurpose: string }; original_issues: string }
	| { type: 'terminal_output'; output: string; outputType: 'stdout' | 'stderr' | 'info'; timestamp: number }
	| { type: 'command_executing'; message: string; commands: string[] }
	| { type: 'command_executed'; message: string; commands: string[]; output?: string }
	| { type: 'command_execution_failed'; message: string; commands: string[]; error?: string }
	| { type: 'static_analysis_results'; staticAnalysis: StaticAnalysisResult }
	| { type: 'runtime_error_found'; errors: RuntimeError[]; count: number }
	| { type: 'conversation_response'; message: string }
	| { type: 'phase_update'; phase: PhaseReport }
	| { type: 'error'; error: string };

export interface HarnessToolsDeps {
	sandbox: SandboxClient;
	onPhaseReport: (phase: PhaseReport) => void;
	/** Optional -- tests and any caller that only needs local phase state (getStatus()) can omit it. */
	onEvent?: (event: HarnessEvent) => void;
}

/** The individual tool definitions, separate from the createSdkMcpServer wrapping below so tests can call each `.handler` directly without reaching into the live MCP server instance's internals. */
export function createHarnessToolDefinitions(deps: HarnessToolsDeps) {
	// Session-scoped: a path seen once already is a rewrite of existing
	// work (file_regenerating/file_regenerated), not a first write
	// (file_generating/file_generated) -- the sandbox itself doesn't
	// expose "did this path already exist" cheaply, and the harness
	// already knows exactly what it's written this session without
	// asking.
	const writtenPaths = new Set<string>();

	const writeFile = tool(
		'write_file',
		'Write one or more files into the generated project. Overwrites existing files at the given paths.',
		{
			files: z.array(z.object({ filePath: z.string(), fileContents: z.string() })).min(1),
			commitMessage: z.string().optional(),
		},
		async ({ files, commitMessage }) => {
			for (const file of files) {
				deps.onEvent?.(
					writtenPaths.has(file.filePath)
						? { type: 'file_regenerating', filePath: file.filePath }
						: { type: 'file_generating', filePath: file.filePath, filePurpose: '' },
				);
			}

			const result = await deps.sandbox.writeFiles(files, commitMessage);
			const failed = new Set(result.results.filter((r) => !r.success).map((r) => r.file));
			for (const file of files) {
				if (failed.has(file.filePath)) continue;
				const wasWritten = writtenPaths.has(file.filePath);
				deps.onEvent?.(
					wasWritten
						? { type: 'file_regenerated', file: { filePath: file.filePath, fileContents: file.fileContents, filePurpose: '' }, original_issues: '' }
						: { type: 'file_generated', file: { filePath: file.filePath, fileContents: file.fileContents, filePurpose: '' } },
				);
				writtenPaths.add(file.filePath);
			}
			const text = failed.size
				? `Wrote ${result.results.length - failed.size}/${result.results.length} files. Failures: ${result.results.filter((r) => !r.success).map((f) => `${f.file}: ${f.error}`).join('; ')}`
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
			deps.onEvent?.({ type: 'command_executing', message: `Running ${commands.length} command(s)`, commands });

			const result = await deps.sandbox.executeCommands(commands, timeoutMs);
			for (const r of result.results) {
				deps.onEvent?.({
					type: 'terminal_output',
					output: `$ ${r.command}\n${r.output}${r.error ? `\n[stderr] ${r.error}` : ''}`,
					outputType: r.error ? 'stderr' : 'stdout',
					timestamp: Date.now(),
				});
			}
			const failures = result.results.filter((r) => !r.success);
			deps.onEvent?.(
				failures.length
					? {
							type: 'command_execution_failed',
							message: `${failures.length}/${result.results.length} command(s) failed`,
							commands,
							error: failures.map((f) => `${f.command}: ${f.error ?? `exit ${f.exitCode}`}`).join('; '),
						}
					: { type: 'command_executed', message: `${result.results.length} command(s) completed`, commands, output: result.results.map((r) => r.output).join('\n') },
			);

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
			deps.onEvent?.({ type: 'static_analysis_results', staticAnalysis: result });
			const text = `Typecheck: ${result.typecheck.summary.errorCount} error(s), ${result.typecheck.summary.warningCount} warning(s)\n${result.typecheck.rawOutput}`;
			return { content: [{ type: 'text', text }] };
		},
	);

	const getRuntimeErrors = tool(
		'get_runtime_errors',
		'Check the running dev server for runtime errors captured since the last check. Call this after starting/restarting the dev server, and again before finishing, to catch and fix issues the model would otherwise never see.',
		{},
		async () => {
			const result = await deps.sandbox.getErrors();
			deps.onEvent?.({ type: 'runtime_error_found', errors: result.errors, count: result.errors.length });
			const text = result.errors.length
				? `${result.errors.length} runtime error(s) found:\n${result.errors.map((e) => `[${e.timestamp}] ${e.message}`).join('\n')}`
				: 'No runtime errors found.';
			return { content: [{ type: 'text', text }] };
		},
	);

	const reportPhase = tool(
		'report_phase',
		'Report progress through the generation phases (e.g. planning, scaffold, implementation, review). Call with status "started" when beginning a phase and "completed" when it finishes. This is the only way phase progress reaches the user -- call it for every phase transition.',
		{ name: z.string(), status: z.enum(['started', 'completed']) },
		async ({ name, status }) => {
			deps.onPhaseReport({ name, status });
			deps.onEvent?.({ type: 'phase_update', phase: { name, status } });
			return { content: [{ type: 'text', text: 'ok' }] };
		},
	);

	return [writeFile, readFile, runCommand, runStaticAnalysis, getRuntimeErrors, reportPhase];
}

export function createHarnessTools(deps: HarnessToolsDeps) {
	return createSdkMcpServer({
		name: 'harness',
		version: '0.0.1',
		tools: createHarnessToolDefinitions(deps),
	});
}
