/** Minimal in-memory fake for the subset of DynamoDBDocumentClient UsageStore actually uses. */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown> & { pk: string; sk: string };

export class FakeDynamoDocumentClient {
	private readonly items: Item[] = [];

	async send(command: unknown): Promise<unknown> {
		if (command instanceof PutCommand) {
			this.items.push(command.input.Item as Item);
			return {};
		}
		if (command instanceof QueryCommand) {
			return this.applyQuery(command);
		}
		throw new Error(`FakeDynamoDocumentClient: unhandled command ${(command as { constructor?: { name?: string } })?.constructor?.name}`);
	}

	private applyQuery(command: QueryCommand): { Items: Item[] } {
		const indexName = command.input.IndexName;
		const values = command.input.ExpressionAttributeValues ?? {};
		const pkAttr = indexName ? `${indexName}pk` : 'pk';
		const skAttr = indexName ? `${indexName}sk` : 'sk';
		const pkValue = values[':pk'];
		const cutoff = values[':cutoff'] as string;

		return {
			Items: this.items
				.filter((item) => item[pkAttr] === pkValue && (item[skAttr] as string) >= cutoff)
				.sort((a, b) => (a[skAttr] as string).localeCompare(b[skAttr] as string)),
		};
	}
}
