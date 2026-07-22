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
}

export type OutgoingMessage = { type: string } & Record<string, unknown>;

/**
 * Injected rather than imported directly from vibesdk-llm-client, so
 * this module's dispatch logic stays testable without a real (or
 * fetch-mocked) network call -- see handler.ts for the real
 * implementation (./llm.ts's `generateAssistantReply`).
 */
export interface GenerationResult {
	projectName: string;
	files: { filePath: string; fileContents: string }[];
	previewUrl?: string;
	sandboxInstanceId?: string;
	bootstrapMessage?: string;
	gitCommitSha?: string;
	gitCommitError?: string;
}

export interface MessageDeps {
	generateReply: (conversationHistory: ConversationMessage[], userMessage: string) => Promise<string>;
	runGeneration: (description: string, sessionId: string) => Promise<GenerationResult>;
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
	/** Response to push back over the connection, built from the final state. `null` = no response (matches the original's silent handling of a few message types). */
	buildResponse: (state: AgentSessionState) => OutgoingMessage | null;
}

const NOT_IMPLEMENTED_MESSAGE =
	'This capability is not yet available on the AWS runtime -- the deployment manager, screenshot capture, and resuming a partial generation have not been ported yet.';

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
				// Calls the LLM (via deps.generateReply) before returning the
				// user+assistant turn to persist. This is NOT
				// worker/agents/operations/UserConversationProcessor.ts's real
				// conversational-AI handling (no tool calling, no blueprint/
				// project-state awareness, no streaming) -- a single-turn
				// completion over the conversation history, with a system
				// prompt that's explicit about what this runtime can't do yet.
				// See ./llm.ts. If the call fails (no API key configured, rate
				// limited past retries, etc.) this throws and nothing is
				// persisted -- handler.ts turns that into an `error` response.
				mutate: async (state) => {
					const reply = await deps.generateReply(state.conversation_messages, content);
					const now = new Date().toISOString();
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
				buildResponse: (state) => ({
					type: 'conversation_state',
					state: {
						conversationMessages: state.conversation_messages,
						pendingUserInputs: state.pending_user_inputs,
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
				// See ./generation.ts for exactly what this does and doesn't
				// do (one LLM call for a small single-shot app, one call to
				// aws/sandbox-orchestrator-lambda to run it) -- not
				// worker/agents/operations/PhaseGeneration.ts's real phased
				// pipeline. On failure (bad JSON from the model, sandbox
				// launch failure, etc.) this throws and nothing is
				// persisted, same error-handling shape as user_suggestion.
				mutate: async (state) => {
					const description = explicitDescription || lastUserMessage(state) || state.query;
					if (!description) {
						throw new Error('No project description available -- include a message with generate_all, or send a user_suggestion first.');
					}
					const result = await deps.runGeneration(description, state.session_id);
					const now = new Date().toISOString();
					return {
						...state,
						query: state.query || description,
						project_name: result.projectName,
						generated_files: Object.fromEntries(result.files.map((f) => [f.filePath, f.fileContents])),
						sandbox_instance_id: result.sandboxInstanceId,
						preview_url: result.previewUrl,
						git_commit_sha: result.gitCommitSha,
						git_commit_error: result.gitCommitError,
						current_dev_state: 'REVIEWING',
						should_be_generating: false,
						updated_at: now,
					};
				},
				buildResponse: (state) => ({
					type: 'generation_complete',
					projectName: state.project_name,
					files: Object.entries(state.generated_files).map(([filePath, fileContents]) => ({ filePath, fileContents })),
					previewUrl: state.preview_url,
					gitCommitSha: state.git_commit_sha,
					gitCommitError: state.git_commit_error,
				}),
			};
		}

		case 'resume_generation':
		case 'deploy':
		case 'preview':
		case 'capture_screenshot':
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
