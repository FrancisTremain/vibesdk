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

import type { AgentSessionState } from './state';

export interface IncomingMessage {
	type: string;
	message?: string;
	images?: unknown[];
}

export type OutgoingMessage = { type: string } & Record<string, unknown>;

export interface MessagePlan {
	/** Validation/precondition failure -- short-circuits before any state load. */
	immediateError?: string;
	/** Present only for message types that mutate session state. */
	mutate?: (state: AgentSessionState) => AgentSessionState;
	/** Response to push back over the connection, built from the final state. `null` = no response (matches the original's silent handling of a few message types). */
	buildResponse: (state: AgentSessionState) => OutgoingMessage | null;
}

const NOT_IMPLEMENTED_MESSAGE =
	'This capability is not yet available on the AWS runtime -- the phase-generation pipeline, deployment manager, and screenshot capture have not been ported yet.';

function notImplemented(): MessagePlan {
	return {
		buildResponse: () => ({ type: 'error', error: NOT_IMPLEMENTED_MESSAGE }),
	};
}

function noResponse(): MessagePlan {
	return { buildResponse: () => null };
}

export function planMessage(incoming: IncomingMessage): MessagePlan {
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
				mutate: (state) => ({
					...state,
					conversation_messages: [
						...state.conversation_messages,
						{ role: 'user', content, created_at: new Date().toISOString() },
					],
					pending_user_inputs: [...state.pending_user_inputs, content],
					updated_at: new Date().toISOString(),
				}),
				// The real conversational-AI response (worker/agents/operations/
				// UserConversationProcessor.ts) is not ported -- this only
				// acknowledges receipt and persists the message, honestly
				// short of a real assistant reply.
				buildResponse: () => ({ type: 'user_suggestions_processing', message: 'Message received' }),
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

		case 'generate_all':
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
