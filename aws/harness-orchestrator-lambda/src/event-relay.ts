/**
 * Relays a HarnessEvent (aws/agent-harness/src/tools.ts's file_generated /
 * terminal_output / phase_update / error) pushed by a running harness task
 * straight to the browser's open WebSocket connection, bypassing
 * aws/agent-runtime's Lambda entirely for delivery -- that Lambda only runs
 * reactively per inbound client message, so it has no channel for a
 * server-initiated push. This is the other direction from every other call
 * in this package: the harness task calls *in* to POST /api/harness/sessions/{id}/events
 * (see ./handler.ts), and this module fans that out to every WebSocket
 * connection currently open for that same session id (the harness's
 * sessionId and aws/agent-runtime's chat session_id are the same value --
 * see aws/agent-runtime/src/harness-generation.ts, which passes its own
 * sessionId straight through as the harness session's id).
 *
 * Cross-module access: the connections table and the WebSocket API's
 * management endpoint live in the root stack's aws/infra/agent-runtime.tf,
 * a separate Terraform root module from this one -- bridged via SSM
 * parameters the same way aws/infra/user-credentials.tf's KMS key/identity
 * table are bridged into this module already. See
 * aws/infra/harness/orchestrator.tf for the data sources and IAM.
 */

import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

export interface ConnectionsLookup {
	query(sessionId: string): Promise<string[]>;
}

export class DynamoDbConnectionsLookup implements ConnectionsLookup {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
		private readonly sessionIndexName: string,
	) {}

	async query(sessionId: string): Promise<string[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				IndexName: this.sessionIndexName,
				KeyConditionExpression: 'session_id = :sessionId',
				ExpressionAttributeValues: { ':sessionId': sessionId },
			}),
		);
		return (result.Items ?? []).map((item) => item.connection_id as string).filter(Boolean);
	}
}

/** Best-effort fan-out -- a delivery failure (stale/closed connection, transient API Gateway error) for one connectionId must never block delivery to another, or fail the harness task's push call. */
export async function relayEvent(
	connections: ConnectionsLookup,
	management: Pick<ApiGatewayManagementApiClient, 'send'>,
	sessionId: string,
	event: Record<string, unknown>,
): Promise<void> {
	const connectionIds = await connections.query(sessionId);
	const payload = Buffer.from(JSON.stringify(event));

	await Promise.all(
		connectionIds.map(async (connectionId) => {
			try {
				await management.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: payload }));
			} catch {
				// Stale connection (410 Gone) or transient failure -- the
				// browser's own reconnect (aws/agent-runtime's $connect replays
				// current state) recovers from a missed push either way.
			}
		}),
	);
}
