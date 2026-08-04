/**
 * Wraps one Claude Agent SDK query() as this container's single
 * generation session (one Fargate task per chat session -- see
 * aws/infra/harness/main.tf). Runs in streaming-input mode: `prompt`
 * is a long-lived AsyncIterable (./AsyncMessageQueue below) that stays
 * open for the container's whole lifetime, so a follow-up chat
 * message (sendMessage()) reuses the same query(), the same
 * conversation, and the same custom-tool wiring -- no restart, no
 * lost context. See aws/harness-orchestrator-lambda/README for why
 * the task itself is still torn down on a 10-minute idle timeout
 * despite this: idle Fargate capacity costs money even if the process
 * inside it is doing nothing.
 *
 * Built-in tools are fully disabled (`tools: []`) -- Bash/Write/Edit/
 * Read/Glob/Grep would all touch this container's own filesystem,
 * which has no relationship to the generated project. Everything the
 * model can do instead comes from ./tools.ts's custom tools, which
 * proxy to the target sandbox task.
 *
 * IMPORTANT: /start and /message (./server.ts) do NOT block until a
 * turn finishes -- a real generation turn can run for minutes, far
 * longer than any HTTP/API-Gateway timeout in front of this
 * container. They return as soon as the turn is *accepted* (session
 * id known); the caller polls getStatus() for phase progress and
 * completion, same as aws/harness-orchestrator-lambda's GET
 * .../status route already expects.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createHarnessTools, type HarnessEvent } from './tools';
import { SandboxClient } from './sandbox-client';
import { UserCredentialsClient } from './credentials-client';

export interface PhaseReport {
	name: string;
	status: 'started' | 'completed';
}

export interface HarnessStatus {
	agentSessionId?: string;
	phase?: PhaseReport;
	done: boolean;
	error?: string;
}

export interface HarnessSessionConfig {
	sandboxControlUrl: string;
	sandboxControlSecret: string;
	resumeAgentSessionId?: string;
	/** Set together to route this session through the auth.json branching path instead of the platform's ANTHROPIC_API_KEY -- see ./credentials-client.ts. */
	userId?: string;
	useUserCredentials?: boolean;
	/**
	 * Set together (plus sessionId below) to push real-time HarnessEvents
	 * (file_generated, terminal_output, phase_update) to
	 * aws/harness-orchestrator-lambda's POST /api/harness/sessions/{id}/events
	 * as they happen, instead of only exposing the coarse getStatus()
	 * shape for polling. Optional -- a session with none of these set
	 * still works, just without live push (status polling still reflects
	 * phase/done/error either way).
	 */
	eventsEndpoint?: string;
	eventsSecret?: string;
	/** This session's id, needed to address the events POST above -- aws/harness-orchestrator-lambda's own session id, passed through from its /start call body. */
	sessionId?: string;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

/** Writes an uploaded `.credentials.json` export to a fresh temp dir and points CLAUDE_CONFIG_DIR at it, so the Agent SDK's in-process credential lookup (sdk.mjs reads `$CLAUDE_CONFIG_DIR/.credentials.json`) picks it up instead of the task-definition's ANTHROPIC_API_KEY. */
async function materializeUserCredentials(credentialsJson: Record<string, unknown>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'harness-credentials-'));
	await writeFile(join(dir, '.credentials.json'), JSON.stringify(credentialsJson), { mode: 0o600 });
	process.env.CLAUDE_CONFIG_DIR = dir;
	// The CLI/SDK prefers an explicit API key over OAuth credentials when
	// both are present -- unset it so the file just written actually wins.
	delete process.env.ANTHROPIC_API_KEY;
}

/** A long-lived AsyncIterable that query() consumes as `prompt`; push() feeds it new user turns without ever closing the underlying stream. */
class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
	private readonly buffered: SDKUserMessage[] = [];
	private readonly waiters: ((msg: SDKUserMessage | undefined) => void)[] = [];
	private closed = false;

	push(content: string): void {
		const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
		const waiter = this.waiters.shift();
		if (waiter) waiter(msg);
		else this.buffered.push(msg);
	}

	close(): void {
		this.closed = true;
		// Wake any pending iterator so it can observe `closed` and exit instead of hanging forever.
		while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		while (!this.closed) {
			const next = this.buffered.shift();
			if (next) {
				yield next;
				continue;
			}
			const msg = await new Promise<SDKUserMessage | undefined>((resolve) => {
				this.waiters.push(resolve);
			});
			if (msg) yield msg;
		}
	}
}

export class HarnessSession {
	private readonly queue = new AsyncMessageQueue();
	private readonly sandbox: SandboxClient;
	private agentQuery: Query | undefined;
	private agentSessionId: string | undefined;
	private phase: PhaseReport | undefined;
	private done = true;
	private error: string | undefined;
	private consumeLoop: Promise<void> | undefined;

	constructor(
		private readonly config: HarnessSessionConfig,
		private readonly credentialsClient: Pick<UserCredentialsClient, 'getCredentialsJson'> = new UserCredentialsClient(
			process.env.IDENTITY_TABLE ?? '',
		),
	) {
		this.sandbox = new SandboxClient({ baseUrl: config.sandboxControlUrl, secret: config.sandboxControlSecret });
	}

	/** Starts the query() loop and pushes the first user turn. Resolves once the session id is known (fast) -- does not wait for the turn to finish. */
	async start(userPrompt: string): Promise<HarnessStatus> {
		if (this.config.useUserCredentials && this.config.userId) {
			const credentialsJson = await this.credentialsClient.getCredentialsJson(this.config.userId);
			if (credentialsJson) await materializeUserCredentials(credentialsJson);
			// If the user's stored auth mode says byo_credentials but nothing
			// decrypts (cleared between session-create and task-start, or a
			// transient KMS/DynamoDB error), fall through silently to the
			// platform ANTHROPIC_API_KEY still set in this task's environment
			// rather than failing the whole session over an auth-path edge case.
		}

		const tools = createHarnessTools({
			sandbox: this.sandbox,
			onPhaseReport: (phase) => {
				this.phase = phase;
			},
			onEvent: (event) => this.pushEvent(event),
		});

		this.done = false;
		this.agentQuery = query({
			prompt: this.queue,
			options: {
				tools: [],
				mcpServers: { harness: tools },
				permissionMode: 'bypassPermissions',
				resume: this.config.resumeAgentSessionId,
				systemPrompt:
					'You are generating a full-stack web application inside an isolated sandbox. ' +
					'You have no local filesystem or shell access -- use write_file, read_file, run_command, ' +
					'and run_static_analysis, which all operate on the sandbox project. ' +
					'Call report_phase(name, "started") at the beginning of each major phase ' +
					'(e.g. planning, scaffold, implementation, review) and report_phase(name, "completed") ' +
					'when it finishes -- this is the only way the user sees progress, so call it for every phase.',
			},
		});

		this.consumeLoop = this.consume();
		this.queue.push(userPrompt);

		await this.waitForSessionId();
		return this.getStatus();
	}

	/** Pushes a follow-up user message into the still-open session. Does not wait for the turn to finish. */
	sendMessage(content: string): void {
		this.done = false;
		this.queue.push(content);
	}

	getStatus(): HarnessStatus {
		return { agentSessionId: this.agentSessionId, phase: this.phase, done: this.done, error: this.error };
	}

	/** Fire-and-forget push of one HarnessEvent to the orchestrator's event-ingestion route. Never throws -- a delivery failure here must not interrupt the generation loop; getStatus() polling remains the source of truth regardless. */
	private pushEvent(event: HarnessEvent): void {
		const { eventsEndpoint, eventsSecret, sessionId } = this.config;
		if (!eventsEndpoint || !sessionId) return;
		const fetchImpl = this.config.fetchImpl ?? fetch;
		fetchImpl(`${eventsEndpoint.replace(/\/$/, '')}/api/harness/sessions/${encodeURIComponent(sessionId)}/events`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(eventsSecret ? { 'x-controlplane-secret': eventsSecret } : {}) },
			body: JSON.stringify(event),
		}).catch(() => {
			// Best-effort -- see method comment.
		});
	}

	/** Closes the underlying query and stops accepting input. Returns the final status (including the resume id) so the caller can persist it. */
	async shutdown(): Promise<HarnessStatus> {
		this.queue.close();
		this.agentQuery?.close();
		return this.getStatus();
	}

	private async waitForSessionId(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (!this.agentSessionId && !this.error && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	private async consume(): Promise<void> {
		if (!this.agentQuery) return;
		try {
			for await (const message of this.agentQuery) {
				const sessionId = (message as { session_id?: string }).session_id;
				if (sessionId) this.agentSessionId = sessionId;

				if (message.type === 'result') {
					this.done = true;
					if (message.subtype !== 'success') {
						this.error = message.errors.join('; ') || message.subtype;
						this.pushEvent({ type: 'error', error: this.error });
					} else {
						this.pushEvent({ type: 'phase_update', phase: this.phase ?? { name: 'done', status: 'completed' } });
					}
				}
			}
		} catch (err) {
			this.error = (err as Error).message;
			this.done = true;
		}
	}
}
