/**
 * Wrapper around the vibesdk-harness-sessions DynamoDB table
 * (aws/infra/harness/main.tf: single hash key `sessionId`, no sort
 * key -- one item per chat session, independent of whether a Fargate
 * task is currently running for it). Tracks:
 *
 *  - RUNNING: task alive, sessionId -> task ARN + public IP, proxy
 *    calls go straight to that task's control plane.
 *  - IDLE: the idle sweep (aws/infra/harness/orchestrator.tf's
 *    EventBridge rule) already tore the task down. taskArn/publicIp
 *    are cleared but `agentSessionId` (the Agent SDK's own session
 *    id, captured from the harness container's /start or /shutdown
 *    response) is kept so a later message can relaunch a task and
 *    resume the same conversation via query({resume: agentSessionId}).
 *  - PROVISIONING / ERROR: same meaning as
 *    aws/sandbox-orchestrator-lambda's instances-store.ts.
 */

import {
	DeleteCommand,
	GetCommand,
	PutCommand,
	ScanCommand,
	UpdateCommand,
	type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

export type HarnessSessionStatus = 'PROVISIONING' | 'RUNNING' | 'IDLE' | 'ERROR';

export interface HarnessSessionRecord {
	sessionId: string;
	taskArn?: string;
	publicIp?: string;
	status: HarnessSessionStatus;
	/** The Agent SDK's own session id -- set once the harness container reports it, used to resume after an idle teardown. */
	agentSessionId?: string;
	/** Captured once at session creation so a later resume (after an idle teardown) doesn't need the caller to resupply which sandbox task to proxy tool calls to. */
	sandboxControlUrl: string;
	sandboxControlSecret: string;
	/** Captured once at session creation so a resume-after-idle-teardown relaunch stays on the same auth branch without the caller resupplying it -- see aws/agent-harness/src/credentials-client.ts. */
	userId?: string;
	useUserCredentials?: boolean;
	/** The sandbox instance this harness session is driving -- captured once at creation (aws/agent-runtime/src/harness-generation.ts passes its own sandbox.runId through) so receiveEvent() can forward real generation activity as the sandbox's own activity signal (aws/sandbox-orchestrator-lambda's reaper idle-sweep), without the caller resupplying it on every event push. */
	sandboxInstanceId?: string;
	createdAt: number;
	lastActivityAt: number;
	expiresAt: number;
	error?: string;
}

// A resumable (IDLE) session should survive a full workday gap (the
// "go to work, resume ~12h later" case this was designed around), not
// just the few-hours window aws/sandbox-orchestrator-lambda's
// instances table uses -- that table only ever tracks a live task, this
// one also tracks resumable-but-torn-down sessions. Refreshed on every
// touch (see update()'s callers), so an active session's row never
// actually expires mid-use.
const TTL_SECONDS = 24 * 60 * 60;

export function newExpiresAt(): number {
	return Math.floor(Date.now() / 1000) + TTL_SECONDS;
}

export class HarnessSessionsStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async put(record: HarnessSessionRecord): Promise<void> {
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: record }));
	}

	async get(sessionId: string): Promise<HarnessSessionRecord | undefined> {
		const result = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { sessionId } }));
		return result.Item as HarnessSessionRecord | undefined;
	}

	async listAll(): Promise<HarnessSessionRecord[]> {
		const result = await this.ddb.send(new ScanCommand({ TableName: this.tableName }));
		return (result.Items ?? []) as HarnessSessionRecord[];
	}

	async update(sessionId: string, patch: Partial<Omit<HarnessSessionRecord, 'sessionId'>>): Promise<void> {
		const names: Record<string, string> = {};
		const values: Record<string, unknown> = {};
		const sets: string[] = [];

		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			names[`#${key}`] = key;
			values[`:${key}`] = value;
			sets.push(`#${key} = :${key}`);
		}
		if (sets.length === 0) return;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { sessionId },
				UpdateExpression: `SET ${sets.join(', ')}`,
				ExpressionAttributeNames: names,
				ExpressionAttributeValues: values,
			}),
		);
	}

	async delete(sessionId: string): Promise<void> {
		await this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: { sessionId } }));
	}
}
