/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * SandboxInstancesStore uses. Simpler than the pk/sk fake in
 * aws/user-api-lambda's copy -- this package's table has a single
 * hash key (`instanceId`, no sort key) and needs Scan (for
 * listAllInstances), neither of which that copy supports. Same
 * `constructor.name` dispatch reasoning as every other package's
 * copy of this file -- see that file's own comment.
 */

import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown> & { instanceId: string };

export class FakeDynamoDocumentClient {
	private readonly items = new Map<string, Item>();

	get size(): number {
		return this.items.size;
	}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;

		if (kind === 'PutCommand') {
			const item = (command as PutCommand).input.Item as Item;
			this.items.set(item.instanceId, item);
			return {};
		}
		if (kind === 'GetCommand') {
			const { instanceId } = (command as GetCommand).input.Key as { instanceId: string };
			return { Item: this.items.get(instanceId) };
		}
		if (kind === 'DeleteCommand') {
			const { instanceId } = (command as DeleteCommand).input.Key as { instanceId: string };
			this.items.delete(instanceId);
			return {};
		}
		if (kind === 'ScanCommand') {
			return { Items: Array.from(this.items.values()) };
		}
		if (kind === 'UpdateCommand') {
			const c = command as UpdateCommand;
			const { instanceId } = c.input.Key as { instanceId: string };
			const existing = this.items.get(instanceId) ?? ({ instanceId } as Item);
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
			this.items.set(instanceId, updated);
			return {};
		}
		throw new Error(`FakeDynamoDocumentClient: unhandled command ${kind}`);
	}
}
