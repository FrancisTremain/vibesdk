/**
 * The real actor-model session runtime, built on aws/actor-spike's
 * proven Lambda-per-WebSocket-message plumbing (connection routing,
 * optimistic-lock state persistence) -- see that package's README for
 * what it de-risked. This package replaces the spike's placeholder
 * counter mutation with real session state
 * (worker/agents/core/state.ts's reduced port, see ./state.ts) and
 * real message dispatch (worker/agents/core/websocket.ts's reduced
 * port, see ./messages.ts).
 *
 * Three routes, same as the spike: $connect (record the connection,
 * load-or-init session state, ack with `agent_connected`), $disconnect
 * (remove the connection record), $default (dispatch by message
 * `type`, mutate+persist under the optimistic lock when the message
 * type calls for it, push a response).
 *
 * See this package's README for exactly which
 * worker/agents/core/websocket.ts message types are really
 * implemented here vs. deliberately stubbed as "not implemented".
 */

import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { AppStore } from 'vibesdk-db-apps';
import { newSessionState, nowEpochSeconds, type AgentSessionState, type WsConnectionRecord } from './state';
import { planMessage, type IncomingMessage, type MessageDeps, type OutgoingMessage } from './messages';
import { generateAssistantReply } from './llm';
import { startHarnessGeneration } from './harness-generation';
import { getHarnessStatus, sendHarnessMessage, recordHarnessActivity } from './harness-client';
import { getSandboxFiles } from './sandbox-client';
import { commitGeneratedFiles } from './git-commit';
import { deployProject } from './deploy';
import { captureScreenshot } from './browser-capture-client';

const AGENT_SESSIONS_TABLE = requireEnv('AGENT_SESSIONS_TABLE');
const AGENT_CONNECTIONS_TABLE = requireEnv('AGENT_CONNECTIONS_TABLE');

const CONNECTION_TTL_SECONDS = 60 * 60 * 4; // 4h, same ceiling as aws/actor-spike
const LOCK_RETRY_LIMIT = 5;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let apps = new AppStore(ddb, requireEnv('APPS_TABLE'));

/**
 * Test-only override for the vibesdk-db-apps AppStore. Needed because
 * that package ships its own bundled copy of @aws-sdk/lib-dynamodb
 * (esbuild's `--external:@aws-sdk/*` still resolves against
 * db-apps/node_modules at runtime, not this package's) -- aws-sdk-
 * client-mock's `.on(Command, ...)` matches via `instanceof` against
 * *this* file's imported Command classes, which fails silently against
 * commands built from that other copy. Same problem, same fix
 * (dependency injection instead of relying on the shared mock) as
 * aws/auth-api-lambda and aws/user-api-lambda's `setDdbClientForTests`.
 */
export function setAppStoreForTests(store: AppStore | null): void {
	apps = store ?? new AppStore(ddb, requireEnv('APPS_TABLE'));
}

const messageDeps: MessageDeps = {
	generateReply: generateAssistantReply,
	startHarnessGeneration,
	pollHarnessStatus: getHarnessStatus,
	sendHarnessMessage: async (harnessSessionId, content) => {
		await sendHarnessMessage(harnessSessionId, content);
	},
	recordHarnessActivity,
	getSandboxFiles,
	commitToGitStorage: commitGeneratedFiles,
	deployProject,
	captureScreenshot,
	ensureAppRecord: async ({ id, userId, title, originalPrompt }) => {
		await apps.ensureApp(id, {
			title,
			description: null,
			iconUrl: null,
			originalPrompt,
			finalPrompt: null,
			framework: null,
			userId,
			sessionToken: null,
			visibility: 'private',
			status: 'generating',
			deploymentId: null,
			githubRepositoryUrl: null,
			githubRepositoryVisibility: null,
			isArchived: false,
			isFeatured: false,
			version: 1,
			parentAppId: null,
			previewVersion: 0,
			screenshotUrl: null,
			screenshotCapturedAt: null,
			lastDeployedAt: null,
		});
	},
	markAppCompleted: async (id) => {
		await apps.updateApp(id, { status: 'completed' });
	},
};

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
	const routeKey = event.requestContext.routeKey;
	const connectionId = event.requestContext.connectionId;

	switch (routeKey) {
		case '$connect':
			return handleConnect(event, connectionId);
		case '$disconnect':
			return handleDisconnect(connectionId);
		case '$default':
			return handleMessage(event, connectionId);
		default:
			return { statusCode: 400, body: `Unknown routeKey: ${routeKey}` };
	}
}

async function handleConnect(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
): Promise<APIGatewayProxyResultV2> {
	const sessionId = event.queryStringParameters?.sessionId;
	if (!sessionId) {
		return { statusCode: 400, body: 'sessionId query parameter is required' };
	}
	// Placeholder for the original's cookie-derived Cloudflare OAuth
	// identity (codingAgent.ts's onConnect / readTokenCookie) -- real
	// auth-token handling on AWS is a separate, unported piece. Accepting
	// it as a query param keeps this slice honest about that gap rather
	// than fabricating a user identity.
	const userId = event.queryStringParameters?.userId ?? 'anonymous';

	const connectionRecord: WsConnectionRecord = {
		connection_id: connectionId,
		session_id: sessionId,
		expires_at: nowEpochSeconds() + CONNECTION_TTL_SECONDS,
	};
	await ddb.send(new PutCommand({ TableName: AGENT_CONNECTIONS_TABLE, Item: connectionRecord }));

	const existing = await ddb.send(new GetCommand({ TableName: AGENT_SESSIONS_TABLE, Key: { session_id: sessionId } }));
	let state = existing.Item as AgentSessionState | undefined;
	if (!state) {
		state = newSessionState(sessionId, userId, CONNECTION_TTL_SECONDS);
		await ddb.send(
			new PutCommand({
				TableName: AGENT_SESSIONS_TABLE,
				Item: state,
				ConditionExpression: 'attribute_not_exists(session_id)',
			}),
		).catch((err) => {
			// Another connection for the same brand-new session raced us --
			// harmless, the session now exists either way.
			if (!isConditionalCheckFailed(err)) throw err;
		});
	}

	// API Gateway does not consider a connection reachable via
	// PostToConnectionCommand until this handler returns -- pushing from
	// inside $connect is architecturally guaranteed to fail, not a
	// transient race, so retrying here would only add latency for no
	// benefit (confirmed live: every attempt failed). This push is
	// therefore best-effort only; the client's real, reliable channel for
	// state.query is get_conversation_state's 'conversation_state'
	// response (sent over the already-established $default route -- see
	// messages.ts), which is what use-chat.ts actually falls back to.
	await pushToConnection(event, connectionId, {
		type: 'agent_connected',
		state: {
			sessionId: state.session_id,
			projectName: state.project_name,
			query: state.query,
			shouldBeGenerating: state.should_be_generating,
			currentDevState: state.current_dev_state,
			conversationMessages: state.conversation_messages,
			pendingUserInputs: state.pending_user_inputs,
		},
	}).catch(() => {});

	return { statusCode: 200, body: 'connected' };
}

const PUSH_RETRY_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = 150;

/**
 * Only safe to use for pushes sent from the $default route (an already-
 * established connection), where a failure is a genuinely transient
 * network blip worth retrying -- NOT from $connect, where API Gateway
 * architecturally cannot deliver a push until the handler returns, so
 * retrying inside that same invocation can never succeed (see
 * handleConnect's single best-effort push above).
 */
async function pushToConnectionWithRetry(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
	payload: OutgoingMessage,
): Promise<void> {
	for (let attempt = 0; attempt < PUSH_RETRY_ATTEMPTS; attempt++) {
		try {
			await pushToConnection(event, connectionId, payload);
			return;
		} catch {
			if (attempt < PUSH_RETRY_ATTEMPTS - 1) {
				await new Promise((resolve) => setTimeout(resolve, PUSH_RETRY_DELAY_MS));
			}
		}
	}
}

async function handleDisconnect(connectionId: string): Promise<APIGatewayProxyResultV2> {
	await ddb.send(new DeleteCommand({ TableName: AGENT_CONNECTIONS_TABLE, Key: { connection_id: connectionId } }));
	return { statusCode: 200, body: 'disconnected' };
}

async function handleMessage(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
): Promise<APIGatewayProxyResultV2> {
	const connection = await ddb.send(
		new GetCommand({ TableName: AGENT_CONNECTIONS_TABLE, Key: { connection_id: connectionId } }),
	);
	const sessionId = (connection.Item as WsConnectionRecord | undefined)?.session_id;
	if (!sessionId) {
		return { statusCode: 404, body: 'unknown connection' };
	}

	const incoming = parseMessage(event.body);
	// generate_all's cold start (ECS RunTask + waitForPublicIp + boot for
	// both the sandbox and harness tasks) can run tens of seconds with no
	// other signal to the client -- overriding just this one dep, per
	// request, lets startHarnessGeneration report progress as
	// platform-level 'infra_status' pushes without messages.ts (which
	// stays connection-agnostic and unit-testable) knowing this Lambda
	// invocation even has a WebSocket connection to push to.
	const deps: MessageDeps = {
		...messageDeps,
		startHarnessGeneration: (description, sessionId, userId) =>
			startHarnessGeneration(description, sessionId, userId, fetch, (stage, status) =>
				pushToConnectionWithRetry(event, connectionId, { type: 'infra_status', stage, status }),
			),
	};
	const plan = planMessage(incoming, deps);

	if (plan.immediateError) {
		await pushToConnection(event, connectionId, { type: 'error', error: plan.immediateError });
		return { statusCode: 200, body: 'ok' };
	}

	let finalState: AgentSessionState;
	if (plan.mutate) {
		const current = await loadOrInitState(sessionId);
		try {
			finalState = await persistWithOptimisticLock(current, plan.mutate);
		} catch (err) {
			// A mutate failure (e.g. the LLM call in user_suggestion's mutate)
			// means nothing was persisted -- no PutCommand ever succeeded for
			// this invocation. Respond with the failure instead of throwing,
			// same as every other error path in this handler.
			await pushToConnection(event, connectionId, { type: 'error', error: err instanceof Error ? err.message : String(err) });
			return { statusCode: 200, body: 'ok' };
		}
	} else {
		finalState = await loadOrInitState(sessionId);
	}

	const response = await plan.buildResponse(finalState);
	if (response) {
		await pushToConnection(event, connectionId, response);
	}

	return { statusCode: 200, body: 'ok' };
}

function parseMessage(body: string | undefined): IncomingMessage {
	if (!body) return { type: 'unknown' };
	try {
		return JSON.parse(body) as IncomingMessage;
	} catch {
		return { type: 'unparseable' };
	}
}

async function loadOrInitState(sessionId: string): Promise<AgentSessionState> {
	const result = await ddb.send(new GetCommand({ TableName: AGENT_SESSIONS_TABLE, Key: { session_id: sessionId } }));
	const existing = result.Item as AgentSessionState | undefined;
	return existing ?? newSessionState(sessionId, 'anonymous', CONNECTION_TTL_SECONDS);
}

/**
 * Same optimistic-lock retry as aws/actor-spike's
 * `persistWithOptimisticLock`: on a conflict, re-read the latest item
 * and reapply `mutate` fresh from it, never compounded onto the stale
 * candidate.
 */
async function persistWithOptimisticLock(
	readState: AgentSessionState,
	mutate: (state: AgentSessionState) => AgentSessionState | Promise<AgentSessionState>,
): Promise<AgentSessionState> {
	let current = readState;

	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
		const toWrite: AgentSessionState = {
			...(await mutate(current)),
			lock_version: current.lock_version + 1,
		};

		try {
			await ddb.send(
				new PutCommand({
					TableName: AGENT_SESSIONS_TABLE,
					Item: toWrite,
					ConditionExpression: 'attribute_not_exists(session_id) OR lock_version = :expected',
					ExpressionAttributeValues: { ':expected': current.lock_version },
				}),
			);
			return toWrite;
		} catch (err) {
			if (!isConditionalCheckFailed(err)) throw err;

			const reread = await ddb.send(new GetCommand({ TableName: AGENT_SESSIONS_TABLE, Key: { session_id: current.session_id } }));
			const latest = reread.Item as AgentSessionState | undefined;
			if (!latest) throw new Error(`Session ${current.session_id} disappeared mid-lock-retry`);
			current = latest;
		}
	}

	throw new Error(`Exceeded lock retry limit (${LOCK_RETRY_LIMIT}) for session ${readState.session_id}`);
}

function isConditionalCheckFailed(err: unknown): boolean {
	return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

async function pushToConnection(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
	payload: OutgoingMessage,
): Promise<void> {
	const domain = event.requestContext.domainName;
	const stage = event.requestContext.stage;
	const client = new ApiGatewayManagementApiClient({ endpoint: `https://${domain}/${stage}` });
	await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(payload)) }));
}
