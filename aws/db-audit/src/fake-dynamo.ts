/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * AppStore actually uses -- the most involved fake in this repo so far,
 * since it's the first one that needs GSI query support (gsi1/gsi2),
 * in addition to TransactWriteItems and negative-delta ADD (for
 * decrementing counters on unfavorite/unstar). No local DynamoDB was
 * available in the environment this was written in.
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
		if (command instanceof PutCommand) {
			this.applyPut(command.input.Item as Item, command.input.ConditionExpression);
			return {};
		}
		if (command instanceof GetCommand) {
			const { pk, sk } = command.input.Key as { pk: string; sk: string };
			return { Item: this.items.get(`${pk}#${sk}`) };
		}
		if (command instanceof DeleteCommand) {
			const { pk, sk } = command.input.Key as { pk: string; sk: string };
			this.items.delete(`${pk}#${sk}`);
			return {};
		}
		if (command instanceof UpdateCommand) {
			this.applyUpdate(command);
			return {};
		}
		if (command instanceof QueryCommand) {
			return this.applyQuery(command);
		}
		if (command instanceof TransactWriteCommand) {
			this.applyTransaction(command);
			return {};
		}
		throw new Error(
			`FakeDynamoDocumentClient: unhandled command ${command?.constructor?.name}`,
		);
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

	private applyQuery(command: QueryCommand): { Items: Item[] } {
		const indexName = command.input.IndexName;
		const values = command.input.ExpressionAttributeValues ?? {};
		const scanForward = command.input.ScanIndexForward ?? true;

		if (indexName) {
			const pkAttr = `${indexName}pk`;
			const skAttr = `${indexName}sk`;
			const pkValue = values[':pk'];
			const matches = Array.from(this.items.values()).filter((item) => item[pkAttr] === pkValue);
			matches.sort((a, b) => {
				const diff = ((a[skAttr] as number) ?? 0) - ((b[skAttr] as number) ?? 0);
				return scanForward ? diff : -diff;
			});
			return { Items: matches };
		}

		const pkValue = values[':pk'] as string;
		const prefix = values[':prefix'] as string | undefined;
		const matches = Array.from(this.items.values()).filter((item) => {
			if (item.pk !== pkValue) return false;
			if (prefix) return item.sk.startsWith(prefix);
			return true;
		});
		return { Items: matches };
	}

	private applyTransaction(command: TransactWriteCommand): void {
		const transactItems = command.input.TransactItems ?? [];

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
