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
 * implemented here vs. deliberately stubbed as "not implemented" --
 * the phase-generation pipeline, deployment manager, and screenshot
 * capture are not ported.
 */

import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { newSessionState, nowEpochSeconds, type AgentSessionState, type WsConnectionRecord } from './state';
import { planMessage, type IncomingMessage, type OutgoingMessage } from './messages';

const AGENT_SESSIONS_TABLE = requireEnv('AGENT_SESSIONS_TABLE');
const AGENT_CONNECTIONS_TABLE = requireEnv('AGENT_CONNECTIONS_TABLE');

const CONNECTION_TTL_SECONDS = 60 * 60 * 4; // 4h, same ceiling as aws/actor-spike
const LOCK_RETRY_LIMIT = 5;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
	});

	return { statusCode: 200, body: 'connected' };
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
	const plan = planMessage(incoming);

	if (plan.immediateError) {
		await pushToConnection(event, connectionId, { type: 'error', error: plan.immediateError });
		return { statusCode: 200, body: 'ok' };
	}

	let finalState: AgentSessionState;
	if (plan.mutate) {
		const current = await loadOrInitState(sessionId);
		finalState = await persistWithOptimisticLock(current, plan.mutate);
	} else {
		finalState = await loadOrInitState(sessionId);
	}

	const response = plan.buildResponse(finalState);
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
	mutate: (state: AgentSessionState) => AgentSessionState,
): Promise<AgentSessionState> {
	let current = readState;

	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
		const toWrite: AgentSessionState = {
			...mutate(current),
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
