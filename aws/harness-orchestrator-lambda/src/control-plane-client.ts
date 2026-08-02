/**
 * Thin HTTP client for one harness task's aws/agent-harness control
 * server, authenticated with the shared X-Controlplane-Secret header
 * -- same pattern as
 * aws/sandbox-orchestrator-lambda/src/control-plane-client.ts.
 *
 * This is the contract aws/agent-harness's server must implement:
 *
 *  - POST /start: begins the Agent SDK's query() in streaming-input
 *    mode against `userPrompt` (or resumes a prior conversation if
 *    `resumeAgentSessionId` is set), with disallowedTools covering the
 *    built-in mutable tools and custom tools (write_file, read_file,
 *    run_command, run_static_analysis, report_phase) that proxy to
 *    `sandboxControlUrl` using `sandboxControlSecret`. Returns once the
 *    Agent SDK reports its own session id.
 *  - POST /message: pushes a follow-up user message into the same
 *    still-open query() via its streamInput() method -- no restart, no
 *    lost context. Returns immediately; progress is observed via
 *    /status polling.
 *  - GET /status: current phase (from the report_phase custom tool's
 *    most recent call), overall done/error state.
 *  - POST /shutdown: graceful stop -- flushes the Agent SDK's session
 *    id (in case it rotated) so idleSweep can persist it for resume,
 *    then exits. Best-effort; the caller stops the ECS task regardless.
 */

export interface ControlPlaneResponse<T = unknown> {
	status: number;
	body: T;
}

export interface StartHarnessRequest {
	sessionId: string;
	userPrompt: string;
	sandboxControlUrl: string;
	sandboxControlSecret: string;
	resumeAgentSessionId?: string;
}

export interface HarnessPhase {
	name: string;
	status: 'started' | 'completed';
}

export interface HarnessStatus {
	agentSessionId?: string;
	phase?: HarnessPhase;
	done: boolean;
	error?: string;
}

export class ControlPlaneClient {
	constructor(
		private readonly baseUrl: string,
		private readonly secret: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ControlPlaneResponse<T>> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				'X-Controlplane-Secret': this.secret,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const responseBody = (await res.json().catch(() => ({}))) as T;
		return { status: res.status, body: responseBody };
	}

	start(req: StartHarnessRequest) {
		return this.request<HarnessStatus>('POST', '/start', req);
	}

	sendMessage(content: string) {
		return this.request('POST', '/message', { content });
	}

	status() {
		return this.request<HarnessStatus>('GET', '/status');
	}

	shutdown() {
		return this.request<HarnessStatus>('POST', '/shutdown');
	}
}
