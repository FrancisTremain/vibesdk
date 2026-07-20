/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * VaultStore actually uses. No local DynamoDB was available in the
 * environment this was written in. Only recognizes the exact
 * UpdateExpression shapes VaultStore sends -- not a general expression
 * parser.
 */

import {
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
} from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown> & { pk: string; sk: string };

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
			const item = command.input.Item as Item;
			this.items.set(`${item.pk}#${item.sk}`, item);
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
			return this.handleUpdate(command);
		}

		if (command instanceof QueryCommand) {
			const values = command.input.ExpressionAttributeValues ?? {};
			const pk = values[':pk'] as string;
			const prefix = values[':prefix'] as string | undefined;

			const matches = Array.from(this.items.values()).filter((item) => {
				if (item.pk !== pk) return false;
				if (prefix) return item.sk.startsWith(prefix);
				return true;
			});
			return { Items: matches };
		}

		throw new Error(
			`FakeDynamoDocumentClient: unhandled command ${command?.constructor?.name}`,
		);
	}

	private handleUpdate(command: UpdateCommand): unknown {
		const { pk, sk } = command.input.Key as { pk: string; sk: string };
		const key = `${pk}#${sk}`;
		const existing = this.items.get(key) ?? ({ pk, sk } as Item);
		const values = command.input.ExpressionAttributeValues ?? {};
		const names = command.input.ExpressionAttributeNames ?? {};
		const expr = command.input.UpdateExpression ?? '';

		// Every SET clause this codebase sends is "attr = :value" or
		// "attr = if_not_exists(attr, :value)", comma-separated, with
		// attribute names optionally aliased via #alias.
		const setClause = expr.replace(/^SET /, '');
		const assignments = setClause.split(',').map((s) => s.trim());

		const updated: Item = { ...existing };
		for (const assignment of assignments) {
			const [rawName, rawValueExpr] = assignment.split('=').map((s) => s.trim());
			const attrName = rawName!.startsWith('#') ? (names[rawName!] as string) : rawName!;

			const ifNotExistsMatch = rawValueExpr!.match(/^if_not_exists\((#?\w+|\w+),\s*(:\w+)\)$/);
			if (ifNotExistsMatch) {
				const valueKey = ifNotExistsMatch[2]!;
				updated[attrName] = existing[attrName] ?? values[valueKey];
			} else {
				updated[attrName] = values[rawValueExpr!];
			}
		}

		this.items.set(key, updated);
		return {};
	}
}
