import { beforeEach, describe, expect, it } from 'vitest';
import type {
	APIGatewayProxyResultV2,
	APIGatewayProxyStructuredResultV2,
	APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
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

process.env.ACTOR_STATE_TABLE = 'vibesdk-actor-state';
process.env.WS_CONNECTIONS_TABLE = 'vibesdk-ws-connections';

const { handler } = await import('./handler');

// The handler always returns the structured form; this repo's Lambda
// never returns the bare-string variant APIGatewayProxyResultV2 also
// permits. Narrow once here instead of casting at every call site.
function asStructured(
	result: APIGatewayProxyResultV2,
): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') {
		throw new Error('Expected a structured result, got a bare string');
	}
	return result;
}

async function callHandler(
	event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
	return asStructured(await handler(event));
}

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

function wsEvent(
	overrides: Partial<APIGatewayProxyWebsocketEventV2> = {},
): APIGatewayProxyWebsocketEventV2 {
	return {
		requestContext: {
			routeKey: '$default',
			connectionId: 'conn-1',
			domainName: 'abc123.execute-api.ap-southeast-2.amazonaws.com',
			stage: 'spike',
			// Fields required by the type but unused by the handler.
			apiId: 'abc123',
			eventType: 'MESSAGE',
			messageId: 'msg-1',
			requestId: 'req-1',
			requestTimeEpoch: Date.now(),
			connectedAt: Date.now(),
			extendedRequestId: 'ext-1',
			messageDirection: 'IN',
		} as APIGatewayProxyWebsocketEventV2['requestContext'],
		body: JSON.stringify({ type: 'ping', client_sent_at: Date.now() }),
		isBase64Encoded: false,
		...overrides,
	} as APIGatewayProxyWebsocketEventV2;
}

beforeEach(() => {
	ddbMock.reset();
	apigwMock.reset();
	apigwMock.on(PostToConnectionCommand).resolves({});
});

describe('$connect', () => {
	it('stores connectionId -> sessionId with a TTL', async () => {
		ddbMock.on(PutCommand).resolves({});

		const result = await callHandler(
			wsEvent({
				requestContext: {
					routeKey: '$connect',
					connectionId: 'conn-1',
				} as APIGatewayProxyWebsocketEventV2['requestContext'],
				queryStringParameters: { sessionId: 'session-abc' },
			}),
		);

		expect(result.statusCode).toBe(200);
		const putCalls = ddbMock.commandCalls(PutCommand);
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0]!.args[0]!.input).toMatchObject({
			TableName: 'vibesdk-ws-connections',
			Item: {
				connection_id: 'conn-1',
				session_id: 'session-abc',
			},
		});
		expect(putCalls[0]!.args[0]!.input.Item!.expires_at).toBeTypeOf('number');
	});

	it('rejects a connect with no sessionId query param', async () => {
		const result = await callHandler(
			wsEvent({
				requestContext: {
					routeKey: '$connect',
					connectionId: 'conn-1',
				} as APIGatewayProxyWebsocketEventV2['requestContext'],
				queryStringParameters: undefined,
			}),
		);

		expect(result.statusCode).toBe(400);
		expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
	});
});

describe('$disconnect', () => {
	it('removes the connection record', async () => {
		ddbMock.on(DeleteCommand).resolves({});

		const result = await callHandler(
			wsEvent({
				requestContext: {
					routeKey: '$disconnect',
					connectionId: 'conn-1',
				} as APIGatewayProxyWebsocketEventV2['requestContext'],
			}),
		);

		expect(result.statusCode).toBe(200);
		const deleteCalls = ddbMock.commandCalls(DeleteCommand);
		expect(deleteCalls[0]!.args[0]!.input).toEqual({
			TableName: 'vibesdk-ws-connections',
			Key: { connection_id: 'conn-1' },
		});
	});
});

describe('$default (message)', () => {
	it('returns 404 for an unknown connection', async () => {
		ddbMock.on(GetCommand, { TableName: 'vibesdk-ws-connections' }).resolves({
			Item: undefined,
		});

		const result = await callHandler(wsEvent());

		expect(result.statusCode).toBe(404);
		expect(apigwMock.commandCalls(PostToConnectionCommand)).toHaveLength(0);
	});

	it('initializes state for a brand-new session and persists message_count 1', async () => {
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-ws-connections' })
			.resolves({ Item: { connection_id: 'conn-1', session_id: 'session-1' } });
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-actor-state' })
			.resolves({ Item: undefined });
		ddbMock.on(PutCommand, { TableName: 'vibesdk-actor-state' }).resolves({});

		const result = await callHandler(wsEvent());

		expect(result.statusCode).toBe(200);
		const putCalls = ddbMock.commandCalls(PutCommand, {
			TableName: 'vibesdk-actor-state',
		});
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0]!.args[0]!.input.Item).toMatchObject({
			session_id: 'session-1',
			message_count: 1,
			lock_version: 1,
		});

		const acks = apigwMock.commandCalls(PostToConnectionCommand);
		expect(acks).toHaveLength(1);
		const payload = JSON.parse(
			Buffer.from(acks[0]!.args[0]!.input.Data as Uint8Array).toString(),
		);
		expect(payload).toMatchObject({
			type: 'actor_spike_ack',
			session_id: 'session-1',
			message_count: 1,
		});
		expect(payload.latency_ms).toEqual(
			expect.objectContaining({
				total: expect.any(Number),
				dynamo_read: expect.any(Number),
				rehydrate: expect.any(Number),
				persist: expect.any(Number),
			}),
		);
	});

	it('increments an existing session state under the optimistic lock', async () => {
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-ws-connections' })
			.resolves({ Item: { connection_id: 'conn-1', session_id: 'session-1' } });
		ddbMock.on(GetCommand, { TableName: 'vibesdk-actor-state' }).resolves({
			Item: {
				session_id: 'session-1',
				lock_version: 3,
				message_count: 7,
				last_mutation_at: '2026-01-01T00:00:00.000Z',
				expires_at: 9999999999,
			},
		});
		ddbMock.on(PutCommand, { TableName: 'vibesdk-actor-state' }).resolves({});

		await handler(wsEvent());

		const putCalls = ddbMock.commandCalls(PutCommand, {
			TableName: 'vibesdk-actor-state',
		});
		expect(putCalls[0]!.args[0]!.input.Item).toMatchObject({
			message_count: 8,
			lock_version: 4,
		});
	});

	it('reapplies the mutation fresh from the re-read state on a lock conflict, not compounded onto the stale candidate', async () => {
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-ws-connections' })
			.resolves({ Item: { connection_id: 'conn-1', session_id: 'session-1' } });

		// Initial read: lock_version 1, message_count 5.
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-actor-state' })
			.resolvesOnce({
				Item: {
					session_id: 'session-1',
					lock_version: 1,
					message_count: 5,
					last_mutation_at: '2026-01-01T00:00:00.000Z',
					expires_at: 9999999999,
				},
			})
			// Re-read after the conflict: another invocation already advanced
			// this to lock_version 2, message_count 6.
			.resolvesOnce({
				Item: {
					session_id: 'session-1',
					lock_version: 2,
					message_count: 6,
					last_mutation_at: '2026-01-01T00:00:01.000Z',
					expires_at: 9999999999,
				},
			});

		ddbMock
			.on(PutCommand, { TableName: 'vibesdk-actor-state' })
			.rejectsOnce(
				Object.assign(new Error('conflict'), {
					name: 'ConditionalCheckFailedException',
				}),
			)
			.resolves({});

		await handler(wsEvent());

		const putCalls = ddbMock.commandCalls(PutCommand, {
			TableName: 'vibesdk-actor-state',
		});
		expect(putCalls).toHaveLength(2);

		// First attempt: mutate(v1) -> message_count 6, lock_version 2.
		expect(putCalls[0]!.args[0]!.input.Item).toMatchObject({
			message_count: 6,
			lock_version: 2,
		});
		expect(putCalls[0]!.args[0]!.input.ExpressionAttributeValues).toEqual({
			':expected': 1,
		});

		// Retry: reapplied fresh from the re-read state (message_count 6),
		// not compounded onto the first attempt's stale candidate (which
		// would incorrectly land on message_count 7 from 6+1 twice).
		expect(putCalls[1]!.args[0]!.input.Item).toMatchObject({
			message_count: 7,
			lock_version: 3,
		});
		expect(putCalls[1]!.args[0]!.input.ExpressionAttributeValues).toEqual({
			':expected': 2,
		});
	});

	it('throws after exceeding the lock retry limit', async () => {
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-ws-connections' })
			.resolves({ Item: { connection_id: 'conn-1', session_id: 'session-1' } });
		ddbMock.on(GetCommand, { TableName: 'vibesdk-actor-state' }).resolves({
			Item: {
				session_id: 'session-1',
				lock_version: 1,
				message_count: 0,
				last_mutation_at: '2026-01-01T00:00:00.000Z',
				expires_at: 9999999999,
			},
		});
		ddbMock.on(PutCommand, { TableName: 'vibesdk-actor-state' }).rejects(
			Object.assign(new Error('conflict'), {
				name: 'ConditionalCheckFailedException',
			}),
		);

		await expect(handler(wsEvent())).rejects.toThrow(/lock retry limit/i);
	});
});
