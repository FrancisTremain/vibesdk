/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * HarnessSessionsStore uses. Single hash key (`sessionId`), needs
 * Scan (for the idle sweep). Same shape as
 * aws/sandbox-orchestrator-lambda/src/fake-dynamo.ts.
 */

import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown> & { sessionId: string };

export class FakeDynamoDocumentClient {
	private readonly items = new Map<string, Item>();

	get size(): number {
		return this.items.size;
	}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;

		if (kind === 'PutCommand') {
			const item = (command as PutCommand).input.Item as Item;
			this.items.set(item.sessionId, item);
			return {};
		}
		if (kind === 'GetCommand') {
			const { sessionId } = (command as GetCommand).input.Key as { sessionId: string };
			return { Item: this.items.get(sessionId) };
		}
		if (kind === 'DeleteCommand') {
			const { sessionId } = (command as DeleteCommand).input.Key as { sessionId: string };
			this.items.delete(sessionId);
			return {};
		}
		if (kind === 'ScanCommand') {
			return { Items: Array.from(this.items.values()) };
		}
		if (kind === 'UpdateCommand') {
			const c = command as UpdateCommand;
			const { sessionId } = c.input.Key as { sessionId: string };
			const existing = this.items.get(sessionId) ?? ({ sessionId } as Item);
			const values = c.input.ExpressionAttributeValues ?? {};
			const names = c.input.ExpressionAttributeNames ?? {};
			const expr = c.input.UpdateExpression ?? '';
			const updated: Item = { ...existing };

			const setMatch = expr.match(/^SET (.+)$/);
			if (setMatch) {
				for (const assignment of setMatch[1]!.split(',').map((s) => s.trim())) {
					const [rawName, rawValueExpr] = assignment.split('=').map((s) => s.trim());
					const attrName = rawName!.startsWith('#') ? (names[rawName!] as string) : rawName!;
					updated[attrName] = values[rawValueExpr!];
				}
			}
			this.items.set(sessionId, updated);
			return {};
		}
		throw new Error(`FakeDynamoDocumentClient: unhandled command ${kind}`);
	}
}
