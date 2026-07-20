/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * DynamoRateLimiter actually uses. No local DynamoDB (DynamoDB Local,
 * LocalStack) was available in the environment this was written in.
 *
 * Deliberately not a general UpdateExpression parser — it only
 * recognizes the exact expression shape DynamoRateLimiter sends
 * (`SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :inc`), matching
 * that one call site rather than trying to be a real DynamoDB emulator.
 */

import { QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

interface Item {
	rate_limit_key: string;
	bucket_start: number;
	count: number;
	ttl: number;
}

export class FakeDynamoDocumentClient {
	private readonly items = new Map<string, Item>();

	get size(): number {
		return this.items.size;
	}

	itemFor(rate_limit_key: string, bucket_start: number): Item | undefined {
		return this.items.get(this.itemKey(rate_limit_key, bucket_start));
	}

	private itemKey(rate_limit_key: string, bucket_start: number): string {
		return `${rate_limit_key}#${bucket_start}`;
	}

	async send(command: unknown): Promise<unknown> {
		if (command instanceof QueryCommand) {
			const values = command.input.ExpressionAttributeValues ?? {};
			const key = values[':key'] as string;
			const hasRange = ':start' in values && ':end' in values;

			const matches = Array.from(this.items.values()).filter((item) => {
				if (item.rate_limit_key !== key) return false;
				if (!hasRange) return true;
				return (
					item.bucket_start >= (values[':start'] as number) &&
					item.bucket_start <= (values[':end'] as number)
				);
			});

			return { Items: matches };
		}

		if (command instanceof UpdateCommand) {
			const { Key, ExpressionAttributeValues } = command.input;
			const rate_limit_key = Key?.rate_limit_key as string;
			const bucket_start = Key?.bucket_start as number;
			const inc = ExpressionAttributeValues?.[':inc'] as number;
			const ttl = ExpressionAttributeValues?.[':ttl'] as number;

			const k = this.itemKey(rate_limit_key, bucket_start);
			const existing = this.items.get(k);
			this.items.set(k, {
				rate_limit_key,
				bucket_start,
				count: (existing?.count ?? 0) + inc,
				ttl: existing?.ttl ?? ttl, // if_not_exists semantics
			});
			return {};
		}

		if (command instanceof DeleteCommand) {
			const { Key } = command.input;
			this.items.delete(
				this.itemKey(Key?.rate_limit_key as string, Key?.bucket_start as number),
			);
			return {};
		}

		throw new Error(
			`FakeDynamoDocumentClient: unhandled command ${command?.constructor?.name}`,
		);
	}
}
