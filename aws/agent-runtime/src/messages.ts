/**
 * Message dispatch for the $default WebSocket route -- the AWS
 * replacement for worker/agents/core/websocket.ts's
 * `handleWebSocketMessage` switch, reduced to the message types this
 * package actually implements (see this package's README for the
 * full list of what's real vs. a deliberate "not implemented" stub).
 *
 * Pure functions only: `mutate` (if present) must be safely
 * re-appliable to a freshly re-read state on an optimistic-lock
 * conflict, same requirement as aws/actor-spike's `applyMutation`.
 * `buildResponse` runs against whatever state was actually persisted
 * (or the as-read state, for non-mutating types), never the
 * pre-mutation candidate.
 */

import type { AgentSessionState, ConversationMessage } from './state';

export interface IncomingMessage {
	type: string;
	message?: string;
	images?: unknown[];
	data?: {
		url?: string;
		viewport?: { width: number; height: number };
		waitSeconds?: number;
	};
}

export type OutgoingMessage = { type: string } & Record<string, unknown>;

/**
 * Injected rather than imported directly from vibesdk-llm-client, so
 * this module's dispatch logic stays testable without a real (or
 * fetch-mocked) network call -- see handler.ts for the real
 * implementation (./llm.ts's `generateAssistantReply`).
 */
export interface HarnessGenerationStart {
	sandboxInstanceId: string;
	previewUrl?: string;
	sandboxControlUrl: string;
	harnessSessionId: string;
	phase?: { name: string; status: 'started' | 'completed' };
	done: boolean;
}

export interface HarnessStatus {
	phase?: { name: string; status: 'started' | 'completed' };
	done: boolean;
	error?: string;
}

export interface DeployResult {
	deployedUrl: string;
	deploymentInstanceId: string;
}

export interface CaptureResult {
	screenshotUrl: string;
	consoleLogs: { type: string; text: string; timestamp: number }[];
}

export interface MessageDeps {
	generateReply: (conversationHistory: ConversationMessage[], userMessage: string, sessionId: string, userId: string) => Promise<string>;
	/** Starts a harness session (aws/agent-harness) against a freshly created, empty sandbox -- see ./harness-generation.ts. Returns once the session is accepted, not once generation finishes (see that module's header for why). */
	startHarnessGeneration: (description: string, sessionId: string, userId: string) => Promise<HarnessGenerationStart>;
	/** Polls the harness's current phase/done state -- see ./harness-client.ts. */
	pollHarnessStatus: (harnessSessionId: string) => Promise<HarnessStatus>;
	/** Pushes a follow-up user turn into an already-running (or resumable) harness session. Does not wait for the turn to finish. */
	sendHarnessMessage: (harnessSessionId: string, content: string) => Promise<void>;
	/** UI-activity heartbeat (editor/preview interaction) -- resets the harness's idle-teardown clock without sending a chat turn. */
	recordHarnessActivity: (harnessSessionId: string) => Promise<void>;
	/** Pulls the final file set out of the sandbox once the harness reports a turn done -- the harness writes files via its own tool calls, this runtime never holds them until this point. */
	getSandboxFiles: (sandboxInstanceId: string) => Promise<{ filePath: string; fileContents: string }[]>;
	/** Best-effort commit of the pulled files to this session's git history in S3 (./git-commit.ts) -- same best-effort semantics generate_all always had; a failure here doesn't fail poll_generation_status. */
	commitToGitStorage: (sessionId: string, files: { filePath: string; fileContents: string }[], message: string) => Promise<{ commitSha: string }>;
	deployProject: (files: { filePath: string; fileContents: string }[], projectName: string, initCommand: string) => Promise<DeployResult>;
	captureScreenshot: (
		sessionId: string,
		url: string,
		viewport?: { width: number; height: number },
		waitSeconds?: number,
	) => Promise<CaptureResult>;
	/**
	 * Best-effort: makes this session resumable from the "My Apps" list
	 * (vibesdk-db-apps, same table the frontend's apps-api/user-api
	 * Lambdas read) -- without this, a generation session only exists
	 * discoverably as an AGENT_SESSIONS_TABLE row nobody ever lists, so
	 * the chat is invisible outside the tab that started it. Idempotent
	 * (see AppStore.ensureApp) -- safe to call again on a mutate retry.
	 * A failure here must never fail generation itself.
	 */
	ensureAppRecord: (params: { id: string; userId: string; title: string; originalPrompt: string }) => Promise<void>;
	/** Flips the app record's status to 'completed' once a generation turn is done -- same best-effort semantics as ensureAppRecord. */
	markAppCompleted: (id: string) => Promise<void>;
}

export interface MessagePlan {
	/** Validation/precondition failure -- short-circuits before any state load. */
	immediateError?: string;
	/**
	 * Present only for message types that mutate session state. May be
	 * async (user_suggestion calls out to the LLM) -- on an optimistic-
	 * lock conflict it is re-invoked against the freshly re-read state,
	 * same requirement aws/actor-spike's `applyMutation` has, just now
	 * allowed to await instead of being a pure sync function.
	 */
	mutate?: (state: AgentSessionState) => AgentSessionState | Promise<AgentSessionState>;
	/**
	 * Response to push back over the connection, built from the final
	 * state. `null` = no response (matches the original's silent
	 * handling of a few message types). May be async (capture_screenshot
	 * calls out to aws/browser-capture-lambda here rather than in
	 * `mutate`, since a screenshot doesn't change session state).
	 */
	buildResponse: (state: AgentSessionState) => OutgoingMessage | null | Promise<OutgoingMessage | null>;
}

const NOT_IMPLEMENTED_MESSAGE =
	'This capability is not yet available on the AWS runtime -- resuming a partial generation, live-preview refresh, and model-config listing have not been ported yet.';

function notImplemented(): MessagePlan {
	return {
		buildResponse: () => ({ type: 'error', error: NOT_IMPLEMENTED_MESSAGE }),
	};
}

function noResponse(): MessagePlan {
	return { buildResponse: () => null };
}

export function planMessage(incoming: IncomingMessage, deps: MessageDeps): MessagePlan {
	switch (incoming.type) {
		// Disabled in the original too ("Disable for now") -- kept as a
		// no-op for wire-protocol parity, not a stub for missing behavior.
		case 'session_init':
			return noResponse();

		case 'user_suggestion': {
			if (!incoming.message) {
				return { immediateError: 'No message provided in user suggestion', buildResponse: () => null };
			}
			const content = incoming.message;
			return {
				// Two paths, branching on whether a harness session already
				// exists for this chat (i.e. generate_all has run at least
				// once): with one, this is the "follow-up iteration" path --
				// push the message into the still-open (or resumable, if
				// idle-torn-down) harness session via deps.sendHarnessMessage
				// and let poll_generation_status surface the reply/phase
				// updates, same as generate_all itself. Without one, this is
				// pre-generation chit-chat, unchanged from the original
				// single-turn deps.generateReply completion (no tool calling,
				// no blueprint/project-state awareness -- see ./llm.ts).
				mutate: async (state) => {
					const now = new Date().toISOString();
					if (state.harness_session_id) {
						await deps.sendHarnessMessage(state.harness_session_id, content);
						return {
							...state,
							conversation_messages: [...state.conversation_messages, { role: 'user', content, created_at: now }],
							pending_user_inputs: [...state.pending_user_inputs, content],
							should_be_generating: true,
							current_dev_state: 'PHASE_IMPLEMENTING',
							updated_at: now,
						};
					}

					const reply = await deps.generateReply(state.conversation_messages, content, state.session_id, state.user_id);
					return {
						...state,
						conversation_messages: [
							...state.conversation_messages,
							{ role: 'user', content, created_at: now },
							{ role: 'assistant', content: reply, created_at: now },
						],
						pending_user_inputs: [...state.pending_user_inputs, content],
						updated_at: now,
					};
				},
				buildResponse: (state) => {
					if (state.harness_session_id) {
						return { type: 'conversation_response', message: 'Working on it...' };
					}
					const last = state.conversation_messages[state.conversation_messages.length - 1];
					return { type: 'conversation_response', message: last?.content ?? '' };
				},
			};
		}

		case 'clear_conversation':
			return {
				mutate: (state) => ({
					...state,
					conversation_messages: [],
					pending_user_inputs: [],
					updated_at: new Date().toISOString(),
				}),
				buildResponse: () => ({ type: 'conversation_cleared' }),
			};

		case 'get_conversation_state':
			return {
				// Also carries `query`, even though the shared ConversationState
				// shape (worker/agents/inferutils/common.ts) doesn't otherwise
				// need it -- this is the fallback delivery path for the
				// original user prompt when agent_connected (pushed from the
				// WebSocket $connect route) never reaches the client. AWS API
				// Gateway only considers a connection reachable via
				// PostToConnectionCommand once $connect returns, so pushing
				// from inside that same invocation can never succeed; this
				// $default-route response is sent after the connection is
				// already established, so it reliably does.
				buildResponse: (state) => ({
					type: 'conversation_state',
					state: {
						conversationMessages: state.conversation_messages,
						pendingUserInputs: state.pending_user_inputs,
						query: state.query,
					},
				}),
			};

		case 'stop_generation':
			return {
				mutate: (state) => ({ ...state, should_be_generating: false, updated_at: new Date().toISOString() }),
				buildResponse: () => ({ type: 'generation_stopped', message: 'Generation stopped' }),
			};

		// vault_unlocked/vault_locked have no response in the original either
		// (they notify a companion secrets-vault WebSocket, not this connection)
		// and this reduced state has no vault-session field to mutate yet.
		case 'vault_unlocked':
		case 'vault_locked':
			return noResponse();

		case 'generate_all': {
			// The description comes from this message if present, else the
			// last user turn in conversation history, else state.query
			// (set the first time a session was created with a query) --
			// resolved inside `mutate` since state isn't loaded yet here.
			const explicitDescription = incoming.message;
			return {
				// Starts a harness session (aws/agent-harness) via
				// deps.startHarnessGeneration -- see that module and
				// ./harness-client.ts for what this actually does (an empty
				// sandbox, then a Claude Agent SDK query() against it with
				// custom tools proxying every mutation there). This resolves
				// once the session is *accepted*, not once generation
				// finishes -- a real phased build can run for minutes, far
				// past any HTTP timeout in front of this Lambda. The client
				// is expected to send poll_generation_status repeatedly
				// after this to observe phase progress and eventual
				// completion. On failure (sandbox launch failure, harness
				// start failure) this throws and nothing is persisted, same
				// error-handling shape as user_suggestion.
				mutate: async (state) => {
					const description = explicitDescription || lastUserMessage(state) || state.query;
					if (!description) {
						throw new Error('No project description available -- include a message with generate_all, or send a user_suggestion first.');
					}
					const result = await deps.startHarnessGeneration(description, state.session_id, state.user_id);
					await deps
						.ensureAppRecord({
							id: state.session_id,
							userId: state.user_id,
							title: description.slice(0, 100),
							originalPrompt: description,
						})
						.catch(() => {});
					const now = new Date().toISOString();
					return {
						...state,
						query: state.query || description,
						sandbox_instance_id: result.sandboxInstanceId,
						preview_url: result.previewUrl,
						sandbox_control_url: result.sandboxControlUrl,
						harness_session_id: result.harnessSessionId,
						current_phase: result.phase,
						current_dev_state: 'PHASE_GENERATING',
						should_be_generating: !result.done,
						updated_at: now,
					};
				},
				buildResponse: (state) => ({
					type: 'generation_started',
					previewUrl: state.preview_url,
					phase: state.current_phase,
				}),
			};
		}

		// Sent repeatedly by the client while should_be_generating is true,
		// after generate_all or a harness-routed user_suggestion. Not a
		// fixed poll interval this runtime enforces -- the client decides
		// its own cadence.
		case 'poll_generation_status':
			return {
				mutate: async (state) => {
					if (!state.harness_session_id) return state;
					// Already completed a prior poll's done-transition -- a
					// no-op re-poll shouldn't re-fetch sandbox files or
					// re-commit to git. Mainly a safety net (the client is
					// expected to stop polling once it receives
					// generation_complete), but a dropped/oversized push
					// previously left the client polling indefinitely, and
					// every one of those retries re-ran this whole expensive
					// transition concurrently, exhausting the optimistic-lock
					// retry budget (caught live).
					if (state.current_dev_state === 'REVIEWING') return state;

					const status = await deps.pollHarnessStatus(state.harness_session_id);
					const now = new Date().toISOString();
					if (!status.done) {
						return { ...state, current_phase: status.phase, should_be_generating: true, updated_at: now };
					}

					// Turn finished -- pull the resulting files out of the
					// sandbox (the harness wrote them there via its own tool
					// calls, this runtime never held them until now), then
					// best-effort commit them to git history -- same
					// best-effort semantics generate_all always had (a
					// working preview is already live by this point; that
					// can't be rolled back, so a git-commit failure
					// shouldn't fail the whole poll).
					const files = state.sandbox_instance_id ? await deps.getSandboxFiles(state.sandbox_instance_id) : [];
					let gitCommitSha: string | undefined;
					let gitCommitError: string | undefined;
					try {
						const result = await deps.commitToGitStorage(state.session_id, files, `Generate: ${state.project_name || state.query}`);
						gitCommitSha = result.commitSha;
					} catch (err) {
						gitCommitError = err instanceof Error ? err.message : String(err);
					}
					await deps.markAppCompleted(state.session_id).catch(() => {});
					return {
						...state,
						current_phase: status.phase,
						generated_files: Object.fromEntries(files.map((f) => [f.filePath, f.fileContents])),
						git_commit_sha: gitCommitSha,
						git_commit_error: gitCommitError,
						current_dev_state: 'REVIEWING',
						should_be_generating: false,
						updated_at: now,
					};
				},
				buildResponse: (state) => {
					if (!state.harness_session_id) return null;
					if (state.should_be_generating) {
						return { type: 'phase_update', phase: state.current_phase };
					}
					// No file contents here -- the client already has every
					// file from the incremental file_generated events the
					// harness pushed during the run (aws/agent-harness/src/
					// tools.ts's write_file), and API Gateway's WebSocket
					// PostToConnection has a hard 128KB-per-message cap.
					// Inlining the full generated project blew through that
					// on anything beyond a trivial app, throwing a 413 that
					// silently ate the only signal telling the client
					// generation was done (caught live).
					return {
						type: 'generation_complete',
						projectName: state.project_name,
						previewUrl: state.preview_url,
						gitCommitSha: state.git_commit_sha,
						gitCommitError: state.git_commit_error,
					};
				},
			};

		// UI-activity heartbeat from the side-by-side editor/preview pane --
		// resets the harness's idle-teardown clock (aws/harness-orchestrator-lambda's
		// 10-minute sliding timeout) without sending a chat turn. No state
		// mutation, so this never contends with the optimistic lock a real
		// message would.
		case 'record_activity':
			return {
				buildResponse: async (state) => {
					if (state.harness_session_id) {
						await deps.recordHarnessActivity(state.harness_session_id).catch(() => {});
					}
					return null;
				},
			};

		case 'deploy':
			return {
				// See ./deploy.ts (in handler.ts's wiring) for what this
				// really does: launches a second, independent sandbox
				// instance from the files generate_all already produced --
				// not the original's blue-green Workers-for-Platforms
				// pipeline, see that file's module comment for why.
				mutate: async (state) => {
					const files = Object.entries(state.generated_files).map(([filePath, fileContents]) => ({ filePath, fileContents }));
					if (files.length === 0) {
						throw new Error('Nothing to deploy yet -- run generate_all first.');
					}
					const result = await deps.deployProject(files, state.project_name || 'deployed-app', state.init_command || 'bun run dev');
					return {
						...state,
						deployed_url: result.deployedUrl,
						deployment_instance_id: result.deploymentInstanceId,
						updated_at: new Date().toISOString(),
					};
				},
				buildResponse: (state) => ({ type: 'deployment_completed', deployedUrl: state.deployed_url }),
			};

		case 'capture_screenshot': {
			const url = incoming.data?.url;
			if (!url) return { immediateError: 'Missing url for screenshot capture', buildResponse: () => null };
			const viewport = incoming.data?.viewport;
			const waitSeconds = incoming.data?.waitSeconds;
			return {
				// No state mutation -- a screenshot doesn't change anything
				// about the session, so this is fetched fresh in
				// buildResponse rather than persisted like generate_all/deploy.
				buildResponse: async (state) => {
					try {
						const result = await deps.captureScreenshot(state.session_id, url, viewport, waitSeconds);
						return { type: 'screenshot_capture_success', screenshotUrl: result.screenshotUrl, consoleLogs: result.consoleLogs };
					} catch (err) {
						return { type: 'screenshot_capture_error', error: err instanceof Error ? err.message : String(err) };
					}
				},
			};
		}

		case 'resume_generation':
		case 'preview':
		case 'get_model_configs':
		case 'terminal_command':
			return notImplemented();

		case 'github_export':
			// Matches the original's own deprecation message for this route
			// (WebSocket-based GitHub export was replaced with an OAuth flow
			// upstream too, independent of this migration).
			return {
				buildResponse: () => ({
					type: 'github_export_error',
					message: 'GitHub export via WebSocket is deprecated',
					error: 'Use the GitHub export button, which redirects to GitHub OAuth authorization.',
				}),
			};

		default:
			return { buildResponse: () => ({ type: 'error', error: `Unknown message type: ${incoming.type}` }) };
	}
}

function lastUserMessage(state: AgentSessionState): string | undefined {
	for (let i = state.conversation_messages.length - 1; i >= 0; i--) {
		const message = state.conversation_messages[i];
		if (message?.role === 'user') return message.content;
	}
	return undefined;
}
