/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * UserStore/ApiKeyStore actually use, including TransactWriteItems with
 * `attribute_not_exists` condition checks — the mechanism the real
 * uniqueness guarantees (email, username, API key hash) depend on. No
 * local DynamoDB was available in the environment this was written in.
 *
 * One difference from every other package's copy of this file: command
 * matching is by `constructor.name`, not `instanceof`. This package
 * drives commands constructed *inside* sibling packages' bundled dist
 * output (vibesdk-db-identity, vibesdk-db-auth-flows) via their
 * `file:` dependencies -- each has its own node_modules with its own
 * copy of `@aws-sdk/lib-dynamodb`, so a `PutCommand` built inside
 * db-identity's bundle is a different class object than the
 * `PutCommand` imported here, even though both come from
 * @aws-sdk/lib-dynamodb at the same version. `instanceof` fails across
 * that boundary; `constructor.name` doesn't care which module instance
 * built the class.
 */

import {
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
	TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown> & { pk: string; sk: string };

class TransactionCanceledError extends Error {
	name = 'TransactionCanceledException';
	CancellationReasons: Array<{ Code?: string }>;
	constructor(reasons: Array<{ Code?: string }>) {
		super('Transaction cancelled');
		this.CancellationReasons = reasons;
	}
}

export class FakeDynamoDocumentClient {
	private readonly items = new Map<string, Item>();

	get size(): number {
		return this.items.size;
	}

	itemFor(pk: string, sk: string): Item | undefined {
		return this.items.get(`${pk}#${sk}`);
	}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;
		const typed = command as
			| PutCommand
			| GetCommand
			| DeleteCommand
			| UpdateCommand
			| QueryCommand
			| TransactWriteCommand;

		if (kind === 'PutCommand') {
			const c = typed as PutCommand;
			this.applyPut(c.input.Item as Item, c.input.ConditionExpression);
			return {};
		}
		if (kind === 'GetCommand') {
			const { pk, sk } = (typed as GetCommand).input.Key as { pk: string; sk: string };
			return { Item: this.items.get(`${pk}#${sk}`) };
		}
		if (kind === 'DeleteCommand') {
			const { pk, sk } = (typed as DeleteCommand).input.Key as { pk: string; sk: string };
			this.items.delete(`${pk}#${sk}`);
			return {};
		}
		if (kind === 'UpdateCommand') {
			this.applyUpdate(typed as UpdateCommand);
			return {};
		}
		if (kind === 'QueryCommand') {
			const values = (typed as QueryCommand).input.ExpressionAttributeValues ?? {};
			const pk = values[':pk'] as string;
			const prefix = values[':prefix'] as string | undefined;
			const matches = Array.from(this.items.values()).filter((item) => {
				if (item.pk !== pk) return false;
				if (prefix) return item.sk.startsWith(prefix);
				return true;
			});
			return { Items: matches };
		}
		if (kind === 'TransactWriteCommand') {
			this.applyTransaction(typed as TransactWriteCommand);
			return {};
		}
		throw new Error(`FakeDynamoDocumentClient: unhandled command ${kind}`);
	}

	private applyPut(item: Item, conditionExpression?: string): void {
		const key = `${item.pk}#${item.sk}`;
		if (conditionExpression === 'attribute_not_exists(pk)' && this.items.has(key)) {
			throw Object.assign(new Error('ConditionalCheckFailedException'), {
				name: 'ConditionalCheckFailedException',
			});
		}
		this.items.set(key, item);
	}

	private applyUpdate(command: UpdateCommand): void {
		const { pk, sk } = command.input.Key as { pk: string; sk: string };
		const key = `${pk}#${sk}`;
		const existing = this.items.get(key) ?? ({ pk, sk } as Item);
		const values = command.input.ExpressionAttributeValues ?? {};
		const names = command.input.ExpressionAttributeNames ?? {};
		const expr = command.input.UpdateExpression ?? '';

		const updated: Item = { ...existing };

		const setMatch = expr.match(/SET (.+?)(?:\s+ADD |\s*$)/);
		if (setMatch) {
			for (const assignment of setMatch[1]!.split(',').map((s) => s.trim())) {
				const [rawName, rawValueExpr] = assignment.split('=').map((s) => s.trim());
				const attrName = rawName!.startsWith('#') ? (names[rawName!] as string) : rawName!;
				updated[attrName] = values[rawValueExpr!];
			}
		}

		const addMatch = expr.match(/ADD (.+)$/);
		if (addMatch) {
			for (const assignment of addMatch[1]!.split(',').map((s) => s.trim())) {
				const [rawName, rawValueExpr] = assignment.split(/\s+/).map((s) => s.trim());
				const attrName = rawName!.startsWith('#') ? (names[rawName!] as string) : rawName!;
				const delta = values[rawValueExpr!] as number;
				updated[attrName] = ((existing[attrName] as number) ?? 0) + delta;
			}
		}

		this.items.set(key, updated);
	}

	private applyTransaction(command: TransactWriteCommand): void {
		const transactItems = command.input.TransactItems ?? [];

		// Check every condition first -- true transactional all-or-nothing.
		const reasons: Array<{ Code?: string }> = [];
		let anyFailed = false;
		for (const item of transactItems) {
			if (item.Put?.ConditionExpression === 'attribute_not_exists(pk)') {
				const key = `${(item.Put.Item as Item).pk}#${(item.Put.Item as Item).sk}`;
				if (this.items.has(key)) {
					anyFailed = true;
					reasons.push({ Code: 'ConditionalCheckFailed' });
					continue;
				}
			}
			reasons.push({});
		}
		if (anyFailed) throw new TransactionCanceledError(reasons);

		// All conditions passed -- apply every write.
		for (const item of transactItems) {
			if (item.Put) {
				const putItem = item.Put.Item as Item;
				this.items.set(`${putItem.pk}#${putItem.sk}`, putItem);
			} else if (item.Update) {
				this.applyUpdate(
					new UpdateCommand({
						TableName: item.Update.TableName,
						Key: item.Update.Key,
						UpdateExpression: item.Update.UpdateExpression,
						ExpressionAttributeNames: item.Update.ExpressionAttributeNames,
						ExpressionAttributeValues: item.Update.ExpressionAttributeValues,
					}),
				);
			} else if (item.Delete) {
				const { pk, sk } = item.Delete.Key as { pk: string; sk: string };
				this.items.delete(`${pk}#${sk}`);
			}
		}
	}
}
