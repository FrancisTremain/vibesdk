/**
 * Thin HTTP client the harness's custom tools (./tools.ts) use to
 * proxy file/command/analysis operations to the target sandbox task's
 * aws/sandbox-controlplane server directly (over its public IP, same
 * as aws/sandbox-orchestrator-lambda/src/control-plane-client.ts talks
 * to it -- this is a second, independent caller of that same
 * contract, not a wrapper around the orchestrator Lambda). The
 * harness never touches a local filesystem or shell for anything that
 * should land in the generated app -- every mutation goes through
 * here, so a runaway agent only ever damages the disposable sandbox
 * task, never this one.
 */

export interface SandboxClientConfig {
	baseUrl: string;
	secret: string;
	fetchImpl?: typeof fetch;
}

export interface WriteFilesResult {
	success: boolean;
	results: { file: string; success: boolean; error?: string }[];
}

export interface GetFilesResult {
	success: boolean;
	files: { filePath: string; fileContents: string }[];
	errors?: { file: string; error: string }[];
}

export interface ExecuteCommandsResult {
	success: boolean;
	results: { command: string; success: boolean; output: string; error?: string; exitCode?: number }[];
}

export interface StaticAnalysisResult {
	success: boolean;
	lint: { issues: unknown[]; summary: { errorCount: number; warningCount: number; infoCount: number } };
	typecheck: { issues: unknown[]; summary: { errorCount: number; warningCount: number; infoCount: number }; rawOutput: string };
}

/** Matches worker/services/sandbox/sandboxTypes.ts's SimpleErrorSchema/RuntimeErrorSchema exactly -- aws/sandbox-controlplane's process-monitor.ts already produces records in this shape, so this is a pass-through, not a new format. */
export interface RuntimeError {
	timestamp: string;
	level: number;
	message: string;
	rawOutput: string;
}

export interface GetErrorsResult {
	success: boolean;
	errors: RuntimeError[];
	hasErrors: boolean;
}

export class SandboxClient {
	constructor(private readonly config: SandboxClientConfig) {}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const fetchImpl = this.config.fetchImpl ?? fetch;
		const res = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				'X-Controlplane-Secret': this.config.secret,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		return (await res.json()) as T;
	}

	writeFiles(files: { filePath: string; fileContents: string }[], commitMessage?: string): Promise<WriteFilesResult> {
		return this.request('POST', '/files', { files, commitMessage });
	}

	getFiles(filePaths: string[]): Promise<GetFilesResult> {
		const qs = filePaths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
		return this.request('GET', `/files${qs ? `?${qs}` : ''}`);
	}

	executeCommands(commands: string[], timeout?: number): Promise<ExecuteCommandsResult> {
		return this.request('POST', '/commands', { commands, timeout });
	}

	runStaticAnalysis(lintFiles?: string[]): Promise<StaticAnalysisResult> {
		return this.request('POST', '/analysis', { lintFiles });
	}

	getErrors(): Promise<GetErrorsResult> {
		return this.request('GET', '/errors');
	}
}
