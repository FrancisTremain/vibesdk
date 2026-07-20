/**
 * Phase 3 actor-model spike (docs/aws-migration-design.md).
 *
 * Not the ported CodeGeneratorAgent — the smallest thing that can test
 * the design's core open question: can a Lambda invoked fresh per
 * WebSocket message, no standing worker process, rehydrate a session's
 * state from DynamoDB, apply a mutation, and respond within an
 * acceptable latency budget?
 *
 * Three routes share one handler, dispatched by API Gateway's
 * $connect/$disconnect/$default routeKey:
 *   - $connect: record connectionId -> sessionId in ws_connections.
 *   - $disconnect: remove that record.
 *   - $default: load session state under an optimistic lock, apply a
 *     placeholder mutation, persist, push a response with latency
 *     measurements back over the same connection.
 */

import type {
	APIGatewayProxyWebsocketEventV2,
	APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
	DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
	ApiGatewayManagementApiClient,
	PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const ACTOR_STATE_TABLE = requireEnv('ACTOR_STATE_TABLE');
const WS_CONNECTIONS_TABLE = requireEnv('WS_CONNECTIONS_TABLE');

const CONNECTION_TTL_SECONDS = 60 * 60 * 4; // 4h, generous ceiling for a spike session
const LOCK_RETRY_LIMIT = 5;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

interface ActorState {
	session_id: string;
	lock_version: number;
	message_count: number;
	last_mutation_at: string;
	expires_at: number;
}

interface WsConnectionRecord {
	connection_id: string;
	session_id: string;
	expires_at: number;
}

interface IncomingMessage {
	type: string;
	payload?: unknown;
	client_sent_at?: number;
}

export async function handler(
	event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> {
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

	const record: WsConnectionRecord = {
		connection_id: connectionId,
		session_id: sessionId,
		expires_at: nowEpochSeconds() + CONNECTION_TTL_SECONDS,
	};

	await ddb.send(
		new PutCommand({ TableName: WS_CONNECTIONS_TABLE, Item: record }),
	);

	return { statusCode: 200, body: 'connected' };
}

async function handleDisconnect(
	connectionId: string,
): Promise<APIGatewayProxyResultV2> {
	await ddb.send(
		new DeleteCommand({
			TableName: WS_CONNECTIONS_TABLE,
			Key: { connection_id: connectionId },
		}),
	);

	return { statusCode: 200, body: 'disconnected' };
}

async function handleMessage(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
): Promise<APIGatewayProxyResultV2> {
	const invocationStart = performance.now();

	const connection = await ddb.send(
		new GetCommand({
			TableName: WS_CONNECTIONS_TABLE,
			Key: { connection_id: connectionId },
		}),
	);
	const sessionId = (connection.Item as WsConnectionRecord | undefined)
		?.session_id;
	if (!sessionId) {
		return { statusCode: 404, body: 'unknown connection' };
	}

	const message = parseMessage(event.body);
	const rehydrateStart = performance.now();
	const { state, dynamoReadMs } = await loadOrInitState(sessionId);
	const rehydrateMs = performance.now() - rehydrateStart;

	const persistStart = performance.now();
	const locked = await persistWithOptimisticLock(state, applyMutation);
	const persistMs = performance.now() - persistStart;

	const totalMs = performance.now() - invocationStart;

	await pushToConnection(event, connectionId, {
		type: 'actor_spike_ack',
		session_id: sessionId,
		message_count: locked.message_count,
		latency_ms: {
			total: round2(totalMs),
			dynamo_read: round2(dynamoReadMs),
			rehydrate: round2(rehydrateMs),
			persist: round2(persistMs),
		},
		echoed_client_sent_at: message.client_sent_at,
	});

	console.log(
		JSON.stringify({
			event: 'actor_spike_message_handled',
			session_id: sessionId,
			total_ms: round2(totalMs),
			rehydrate_ms: round2(rehydrateMs),
			persist_ms: round2(persistMs),
		}),
	);

	return { statusCode: 200, body: 'ok' };
}

function parseMessage(body: string | undefined): IncomingMessage {
	if (!body) return { type: 'unknown' };
	try {
		const parsed = JSON.parse(body) as IncomingMessage;
		return parsed;
	} catch {
		return { type: 'unparseable' };
	}
}

async function loadOrInitState(
	sessionId: string,
): Promise<{ state: ActorState; dynamoReadMs: number }> {
	const readStart = performance.now();
	const result = await ddb.send(
		new GetCommand({
			TableName: ACTOR_STATE_TABLE,
			Key: { session_id: sessionId },
		}),
	);
	const dynamoReadMs = performance.now() - readStart;

	const existing = result.Item as ActorState | undefined;
	if (existing) {
		return { state: existing, dynamoReadMs };
	}

	return {
		state: {
			session_id: sessionId,
			lock_version: 0,
			message_count: 0,
			last_mutation_at: new Date().toISOString(),
			expires_at: nowEpochSeconds() + CONNECTION_TTL_SECONDS,
		},
		dynamoReadMs,
	};
}

function applyMutation(state: ActorState): ActorState {
	return {
		...state,
		message_count: state.message_count + 1,
		last_mutation_at: new Date().toISOString(),
	};
}

/**
 * Optimistic lock: condition the write on lock_version still matching
 * what was read. On a conflict (concurrent invocation for the same
 * session), re-read the latest item and reapply the mutation fresh from
 * it — never compound onto the stale candidate — then retry. This is the
 * explicit stand-in for the Durable Object's free single-threaded
 * serialization.
 */
async function persistWithOptimisticLock(
	readState: ActorState,
	mutate: (state: ActorState) => ActorState,
): Promise<ActorState> {
	let current = readState;

	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
		const toWrite: ActorState = {
			...mutate(current),
			lock_version: current.lock_version + 1,
		};

		try {
			await ddb.send(
				new PutCommand({
					TableName: ACTOR_STATE_TABLE,
					Item: toWrite,
					ConditionExpression:
						'attribute_not_exists(session_id) OR lock_version = :expected',
					ExpressionAttributeValues: { ':expected': current.lock_version },
				}),
			);
			return toWrite;
		} catch (err) {
			if (!isConditionalCheckFailed(err)) throw err;

			const reread = await ddb.send(
				new GetCommand({
					TableName: ACTOR_STATE_TABLE,
					Key: { session_id: current.session_id },
				}),
			);
			const latest = reread.Item as ActorState | undefined;
			if (!latest) {
				throw new Error(
					`Session ${current.session_id} disappeared mid-lock-retry`,
				);
			}
			current = latest;
		}
	}

	throw new Error(
		`Exceeded lock retry limit (${LOCK_RETRY_LIMIT}) for session ${readState.session_id}`,
	);
}

function isConditionalCheckFailed(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'name' in err &&
		(err as { name?: string }).name === 'ConditionalCheckFailedException'
	);
}

async function pushToConnection(
	event: APIGatewayProxyWebsocketEventV2,
	connectionId: string,
	payload: unknown,
): Promise<void> {
	const domain = event.requestContext.domainName;
	const stage = event.requestContext.stage;
	const client = new ApiGatewayManagementApiClient({
		endpoint: `https://${domain}/${stage}`,
	});

	await client.send(
		new PostToConnectionCommand({
			ConnectionId: connectionId,
			Data: Buffer.from(JSON.stringify(payload)),
		}),
	);
}

function nowEpochSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
