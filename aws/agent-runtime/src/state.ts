/**
 * Reduced port of worker/agents/core/state.ts's `BaseProjectState`,
 * scoped to exactly what this package's message handling needs:
 * session identity, generation-control flags, and conversation
 * history. Deliberately NOT a full port of `AgentState`
 * (`PhasicState`/`AgenticState`/`ThinkState`) -- those carry
 * `Blueprint`, `PhaseConceptType`, and `FileOutputType` from
 * worker/agents/schemas.ts (a large zod schema tree tied to the
 * phase-generation pipeline, which this package does not implement
 * yet -- see this package's README for exactly what is and isn't
 * ported). Porting those shapes precisely now would mean guessing at
 * a schema no real logic here exercises.
 *
 * snake_case field names match aws/actor-spike's `ActorState` and
 * `WsConnectionRecord` convention (mirrors DynamoDB attribute naming
 * used throughout this migration's other packages), not the
 * original's camelCase.
 */

export type CurrentDevState = 'IDLE' | 'PHASE_GENERATING' | 'PHASE_IMPLEMENTING' | 'REVIEWING' | 'FINALIZING';

export interface ConversationMessage {
	role: 'user' | 'assistant';
	content: string;
	created_at: string;
}

/** filePath -> file contents. Deliberately not a port of state.ts's
 *  `FileState`/`FileOutputType` (diff tracking, purpose metadata) --
 *  see ./generation.ts and this package's README for why the
 *  generation this runtime does is a single-shot JSON-file-list
 *  completion, not the original's phased/diffed file pipeline. */
export type GeneratedFiles = Record<string, string>;

export interface AgentSessionState {
	session_id: string;
	lock_version: number;
	user_id: string;
	project_name: string;
	query: string;
	should_be_generating: boolean;
	current_dev_state: CurrentDevState;
	conversation_messages: ConversationMessage[];
	pending_user_inputs: string[];
	generated_files: GeneratedFiles;
	/** The shell command generate_all's model chose to start the dev server -- carried forward so deploy (./messages.ts's 'deploy' case) can launch an independent long-lived instance the same way, without asking the model again. */
	init_command?: string;
	sandbox_instance_id?: string;
	preview_url?: string;
	/** Set once generate_all starts a harness session (aws/agent-harness) against the sandbox above -- see ./harness-generation.ts. */
	harness_session_id?: string;
	/** http://<sandbox-ip>:8080, derived from preview_url -- passed to the harness so its custom tools can proxy directly to the sandbox, bypassing aws/sandbox-orchestrator-lambda per tool call. */
	sandbox_control_url?: string;
	/** Most recent report_phase call surfaced by the harness -- what poll_generation_status's buildResponse echoes as `phase_update` between generation_started and generation_complete. */
	current_phase?: { name: string; status: 'started' | 'completed' };
	/** Set by generate_all's best-effort commit to aws/git-storage (./git-commit.ts) -- exactly one of the two is set after a successful generation. */
	git_commit_sha?: string;
	git_commit_error?: string;
	/** Set by a successful 'deploy' message -- a second, independent sandbox instance from preview_url's, so regenerating/closing the live coding session doesn't take the deployed app down with it. */
	deployed_url?: string;
	deployment_instance_id?: string;
	created_at: string;
	updated_at: string;
	expires_at: number;
}

export interface WsConnectionRecord {
	connection_id: string;
	session_id: string;
	expires_at: number;
}

export function newSessionState(sessionId: string, userId: string, ttlSeconds: number): AgentSessionState {
	const now = new Date().toISOString();
	return {
		session_id: sessionId,
		lock_version: 0,
		user_id: userId,
		project_name: '',
		query: '',
		should_be_generating: false,
		current_dev_state: 'IDLE',
		conversation_messages: [],
		pending_user_inputs: [],
		generated_files: {},
		created_at: now,
		updated_at: now,
		expires_at: nowEpochSeconds() + ttlSeconds,
	};
}

export function nowEpochSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
