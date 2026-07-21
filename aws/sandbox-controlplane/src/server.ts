/**
 * Control-plane HTTP server for the AWS sandbox container (runs as the
 * Fargate task's entrypoint process). This is the AWS-designed
 * replacement for the proprietary protocol baked into cloudflare/sandbox's
 * base image -- see aws/sandbox-contract/README.md for why no public spec
 * existed to port against instead of design one.
 *
 * Scope: this server exposes operations for the ONE instance running in
 * this container (there's exactly one Fargate task per sandbox instance).
 * Cross-instance operations (list all instances, look up one by ID from
 * many) belong in the orchestrator Lambda (aws/sandbox-orchestrator-lambda),
 * which tracks instanceId -> task mapping in DynamoDB and proxies
 * per-instance calls to the right container's copy of this server.
 *
 * Reuses container/cli-tools.ts (monitor-cli) unmodified for process
 * lifecycle, error tracking, and log storage -- that code was already
 * Cloudflare-independent (it's the vibesdk team's own process-monitoring
 * system, not part of the proprietary cloudflare/sandbox SDK).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const exec = promisify(execCb);
const execFileAsync = promisify(execFile);

const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? '/workspace/app';
const INSTANCE_ID = process.env.INSTANCE_ID ?? 'unknown-instance';
const DEV_PORT = process.env.DEV_PORT ?? '3000';
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? '8080');
const MONITOR_CLI = process.env.MONITOR_CLI ?? 'monitor-cli';
// Control-plane port is reachable from 0.0.0.0/0 at the security-group
// level (the orchestrator Lambda has no static egress IP without a NAT
// Gateway, which this stack avoids for cost -- see aws/infra/sandbox/main.tf).
// This shared secret is the actual authorization boundary. Required in
// production; only unset in tests, which construct the server directly
// without going through a real network boundary. Read from process.env on
// every call (not frozen at module load) so tests can toggle it per case
// without needing a fresh module instance.
function isAuthorized(req: IncomingMessage): boolean {
	const secret = process.env.CONTROLPLANE_SECRET;
	if (!secret) return true; // test/dev mode, no secret configured
	const provided = req.headers['x-controlplane-secret'];
	if (typeof provided !== 'string' || provided.length !== secret.length) return false;
	return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

let bootstrapped = false;
let bootstrapError: string | undefined;
let processStarted = false;

function resolveWorkspacePath(relPath: string): string {
	const resolved = path.resolve(WORKSPACE_DIR, relPath);
	if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + path.sep)) {
		throw new Error(`Path escapes workspace: ${relPath}`);
	}
	return resolved;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf-8');
	return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
	res.end(payload);
}

async function runMonitorCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileAsync(MONITOR_CLI, args, { cwd: WORKSPACE_DIR, timeout: 30_000 });
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message: string };
		return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
	}
}

// --- POST /bootstrap ---
async function handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = {
		files: { filePath: string; fileContents: string }[];
		projectName: string;
		envVars?: Record<string, string>;
		initCommand?: string;
	};
	const body = await readJsonBody<Body>(req);
	bootstrapped = false;
	bootstrapError = undefined;

	try {
		await mkdir(WORKSPACE_DIR, { recursive: true });
		for (const file of body.files) {
			const dest = resolveWorkspacePath(file.filePath);
			await mkdir(path.dirname(dest), { recursive: true });
			await writeFile(dest, file.fileContents, 'utf-8');
		}

		// Install deps -- prefer bun (already in the base image), fall back to npm.
		try {
			await exec('bun install', { cwd: WORKSPACE_DIR, timeout: 120_000 });
		} catch {
			await exec('npm install', { cwd: WORKSPACE_DIR, timeout: 180_000 });
		}

		const initCommand = body.initCommand ?? 'bun run dev';
		const [cmd = 'bun', ...cmdArgs] = initCommand.split(' ');
		await runMonitorCli([
			'process',
			'start',
			'--instance-id',
			INSTANCE_ID,
			'--cwd',
			WORKSPACE_DIR,
			'--port',
			DEV_PORT,
			'--',
			cmd,
			...cmdArgs,
		]);

		processStarted = true;
		bootstrapped = true;
		sendJson(res, 200, {
			success: true,
			processId: INSTANCE_ID,
			message: 'Bootstrap complete, dev process starting',
		});
	} catch (err) {
		bootstrapError = (err as Error).message;
		sendJson(res, 500, { success: false, error: bootstrapError });
	}
}

// --- GET /status ---
async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (bootstrapError) {
		sendJson(res, 200, { success: false, pending: false, isHealthy: false, error: bootstrapError });
		return;
	}
	if (!bootstrapped) {
		sendJson(res, 200, { success: true, pending: true, isHealthy: false, message: 'Bootstrapping' });
		return;
	}
	const { stdout } = await runMonitorCli(['process', 'status', '--instance-id', INSTANCE_ID, '--format', 'json']);
	let isHealthy = false;
	try {
		const parsed = JSON.parse(stdout);
		isHealthy = parsed?.status === 'running' || parsed?.isHealthy === true;
	} catch {
		// monitor-cli status format not JSON-parseable; treat as unhealthy rather than guess
	}
	sendJson(res, 200, {
		success: true,
		pending: false,
		isHealthy,
		processId: INSTANCE_ID,
		message: isHealthy ? 'Running' : 'Process not yet healthy',
	});
}

// --- POST /files (write) ---
async function handleWriteFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = { files: { filePath: string; fileContents: string }[]; commitMessage?: string };
	const body = await readJsonBody<Body>(req);
	const results: { file: string; success: boolean; error?: string }[] = [];

	for (const file of body.files) {
		try {
			const dest = resolveWorkspacePath(file.filePath);
			await mkdir(path.dirname(dest), { recursive: true });
			await writeFile(dest, file.fileContents, 'utf-8');
			results.push({ file: file.filePath, success: true });
		} catch (err) {
			results.push({ file: file.filePath, success: false, error: (err as Error).message });
		}
	}

	if (body.commitMessage) {
		try {
			await exec('git add -A && git commit -m ' + JSON.stringify(body.commitMessage), { cwd: WORKSPACE_DIR });
		} catch {
			// Non-fatal: git may not be initialized yet, or nothing changed to commit.
		}
	}

	const allOk = results.every((r) => r.success);
	sendJson(res, allOk ? 200 : 207, { success: allOk, results });
}

// --- GET /files ---
async function handleGetFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '', 'http://localhost');
	const requested = url.searchParams.getAll('path');
	const filePaths = requested.length > 0 ? requested : await listAllFiles(WORKSPACE_DIR);

	const files: { filePath: string; fileContents: string }[] = [];
	const errors: { file: string; error: string }[] = [];
	for (const relPath of filePaths) {
		try {
			const contents = await readFile(resolveWorkspacePath(relPath), 'utf-8');
			files.push({ filePath: relPath, fileContents: contents });
		} catch (err) {
			errors.push({ file: relPath, error: (err as Error).message });
		}
	}
	sendJson(res, 200, { success: true, files, errors: errors.length ? errors : undefined });
}

async function listAllFiles(dir: string, base = dir): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listAllFiles(full, base)));
		} else {
			out.push(path.relative(base, full));
		}
	}
	return out;
}

// --- POST /commands (exec) ---
async function handleExecuteCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = { commands: string[]; timeout?: number };
	const body = await readJsonBody<Body>(req);
	const results: { command: string; success: boolean; output: string; error?: string; exitCode?: number }[] = [];

	for (const command of body.commands) {
		try {
			const { stdout, stderr } = await exec(command, {
				cwd: WORKSPACE_DIR,
				timeout: body.timeout ?? 60_000,
			});
			results.push({ command, success: true, output: stdout + (stderr ? `\n${stderr}` : ''), exitCode: 0 });
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
			results.push({
				command,
				success: false,
				output: e.stdout ?? '',
				error: e.stderr ?? e.message,
				exitCode: typeof e.code === 'number' ? e.code : 1,
			});
		}
	}
	sendJson(res, 200, { success: results.every((r) => r.success), results });
}

// --- GET /logs ---
async function handleGetLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '', 'http://localhost');
	const args = ['logs', 'list', '--instance-id', INSTANCE_ID, '--format', 'json'];
	if (url.searchParams.get('onlyRecent') === 'true') {
		args.push('--since', `-${url.searchParams.get('durationSeconds') ?? '300'}s`);
	}
	const { stdout } = await runMonitorCli(args);
	let stdoutLines: string[] = [];
	let stderrLines: string[] = [];
	try {
		const parsed = JSON.parse(stdout) as { stream: string; content: string }[];
		stdoutLines = parsed.filter((l) => l.stream === 'stdout').map((l) => l.content);
		stderrLines = parsed.filter((l) => l.stream === 'stderr').map((l) => l.content);
	} catch {
		stdoutLines = [stdout];
	}
	sendJson(res, 200, { success: true, logs: { stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') } });
}

// --- GET /errors ---
async function handleGetErrors(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '', 'http://localhost');
	const { stdout } = await runMonitorCli(['errors', 'list', '--instance-id', INSTANCE_ID, '--format', 'json']);
	let errors: unknown[] = [];
	try {
		errors = JSON.parse(stdout);
	} catch {
		errors = [];
	}
	if (url.searchParams.get('clear') === 'true') {
		await runMonitorCli(['errors', 'clear', '--instance-id', INSTANCE_ID, '--confirm']);
	}
	sendJson(res, 200, { success: true, errors, hasErrors: errors.length > 0 });
}

// --- POST /errors/clear ---
async function handleClearErrors(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	await runMonitorCli(['errors', 'clear', '--instance-id', INSTANCE_ID, '--confirm']);
	sendJson(res, 200, { success: true, message: 'Errors cleared' });
}

// --- POST /analysis ---
async function handleStaticAnalysis(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = { lintFiles?: string[] };
	await readJsonBody<Body>(req);
	const empty = { issues: [] as unknown[], summary: { errorCount: 0, warningCount: 0, infoCount: 0 } };

	let typecheck = { ...empty, rawOutput: '' };
	try {
		const { stdout, stderr } = await exec('bunx tsc --noEmit', { cwd: WORKSPACE_DIR, timeout: 90_000 });
		typecheck = { ...empty, rawOutput: stdout + stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		typecheck = { ...empty, rawOutput: (e.stdout ?? '') + (e.stderr ?? '') };
	}

	// Lint parsing is deliberately not implemented in this first pass --
	// project lint configs vary too much to guess a parser without a real
	// generated project to test against. rawOutput still carries the
	// tsc output above so the caller isn't flying fully blind.
	sendJson(res, 200, { success: true, lint: empty, typecheck });
}

// --- POST /deploy ---
async function handleDeploy(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	// Deploying a generated app to its own hosting is a separate,
	// not-yet-built piece of this migration (see docs/aws-migration-technical-design.md
	// Phase 5/6) -- this endpoint exists so the contract is fully wired,
	// but returns a clear "not implemented" rather than pretending to succeed.
	sendJson(res, 501, { success: false, message: 'Deploy not implemented', error: 'not_implemented' });
}

// --- POST /shutdown ---
async function handleShutdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (processStarted) {
		await runMonitorCli(['process', 'stop', '--instance-id', INSTANCE_ID, '--force']);
	}
	sendJson(res, 200, { success: true, message: 'Shutdown complete' });
	// Exit shortly after responding so the orchestrator's HTTP call completes first.
	setTimeout(() => process.exit(0), 250);
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
	'POST /bootstrap': handleBootstrap,
	'GET /status': handleStatus,
	'POST /files': handleWriteFiles,
	'GET /files': handleGetFiles,
	'POST /commands': handleExecuteCommands,
	'GET /logs': handleGetLogs,
	'GET /errors': handleGetErrors,
	'POST /errors/clear': handleClearErrors,
	'POST /analysis': handleStaticAnalysis,
	'POST /deploy': handleDeploy,
	'POST /shutdown': handleShutdown,
};

export function createControlPlaneServer() {
	return createServer((req, res) => {
		if (!isAuthorized(req)) {
			sendJson(res, 403, { success: false, error: 'Forbidden' });
			return;
		}
		const url = new URL(req.url ?? '', 'http://localhost');
		const key = `${req.method} ${url.pathname}`;
		const handler = routes[key];
		if (!handler) {
			sendJson(res, 404, { success: false, error: `No route for ${key}` });
			return;
		}
		handler(req, res).catch((err: Error) => {
			if (!res.headersSent) sendJson(res, 500, { success: false, error: err.message });
		});
	});
}

const isMainModule = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMainModule) {
	createControlPlaneServer().listen(CONTROL_PORT, () => {
		console.log(`sandbox-controlplane listening on :${CONTROL_PORT} for instance ${INSTANCE_ID}`);
	});
}
