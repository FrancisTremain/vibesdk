/**
 * Minimal in-memory fake for the subset of DynamoDBDocumentClient
 * UserStore/ApiKeyStore actually use, including TransactWriteItems with
 * `attribute_not_exists` condition checks — the mechanism the real
 * uniqueness guarantees (email, username, API key hash) depend on. No
 * local DynamoDB was available in the environment this was written in.
 *
 * Two differences from every other package's copy of this file:
 *
 * 1. Command matching is by `constructor.name`, not `instanceof`. This
 *    package drives commands constructed *inside* sibling packages'
 *    bundled dist output (vibesdk-db-identity, vibesdk-db-auth-flows,
 *    vibesdk-db-audit) via their `file:` dependencies -- each has its
 *    own node_modules with its own copy of `@aws-sdk/lib-dynamodb`, so
 *    a `PutCommand` built inside db-identity's bundle is a different
 *    class object than the `PutCommand` imported here, even though
 *    both come from @aws-sdk/lib-dynamodb at the same version.
 *    `instanceof` fails across that boundary; `constructor.name`
 *    doesn't care which module instance built the class.
 * 2. `QueryCommand` supports GSI queries (`IndexName`), copied from
 *    `aws/db-apps`'s fake -- needed for `vibesdk-db-audit`'s
 *    `AuditLogStore.listForUser`, which queries the `by-user` GSI.
 * 3. Also handles `vibesdk-rate-limit`'s DynamoRateLimiter commands,
 *    which use a `rate_limit_key`/`bucket_start` key schema instead of
 *    this file's usual `pk`/`sk`, and a `SET ... = if_not_exists(...)
 *    ADD ...` UpdateExpression this generic fake's regex-based
 *    SET/ADD parsing doesn't evaluate function calls in (it would
 *    otherwise write the literal string "if_not_exists(#ttl, :ttl)" as
 *    the ttl value). Detected by the presence of `rate_limit_key` in
 *    the command's Key/ExpressionAttributeValues, kept in a separate
 *    Map so its numeric `bucket_start` sort key doesn't collide with
 *    the string `sk` this file's Item type otherwise assumes.
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

interface RateLimitItem {
	rate_limit_key: string;
	bucket_start: number;
	count: number;
	ttl: number;
}

export class FakeDynamoDocumentClient {
	private readonly items = new Map<string, Item>();
	private readonly rateLimitItems = new Map<string, RateLimitItem>();

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
			const key = (typed as DeleteCommand).input.Key as { pk?: string; sk?: string; rate_limit_key?: string; bucket_start?: number };
			if (key.rate_limit_key !== undefined) {
				this.rateLimitItems.delete(this.rateLimitKeyOf(key.rate_limit_key, key.bucket_start!));
				return {};
			}
			this.items.delete(`${key.pk}#${key.sk}`);
			return {};
		}
		if (kind === 'UpdateCommand') {
			const key = (typed as UpdateCommand).input.Key as { pk?: string; sk?: string; rate_limit_key?: string; bucket_start?: number };
			if (key.rate_limit_key !== undefined) {
				this.applyRateLimitUpdate(typed as UpdateCommand);
				return {};
			}
			this.applyUpdate(typed as UpdateCommand);
			return {};
		}
		if (kind === 'QueryCommand') {
			const values = (typed as QueryCommand).input.ExpressionAttributeValues ?? {};
			if (':key' in values) return this.applyRateLimitQuery(typed as QueryCommand);
			return this.applyQuery(typed as QueryCommand);
		}
		if (kind === 'TransactWriteCommand') {
			this.applyTransaction(typed as TransactWriteCommand);
			return {};
		}
		throw new Error(`FakeDynamoDocumentClient: unhandled command ${kind}`);
	}

	private rateLimitKeyOf(rate_limit_key: string, bucket_start: number): string {
		return `${rate_limit_key}#${bucket_start}`;
	}

	private applyRateLimitUpdate(command: UpdateCommand): void {
		const { Key, ExpressionAttributeValues } = command.input;
		const rate_limit_key = Key?.rate_limit_key as string;
		const bucket_start = Key?.bucket_start as number;
		const inc = ExpressionAttributeValues?.[':inc'] as number;
		const ttl = ExpressionAttributeValues?.[':ttl'] as number;

		const k = this.rateLimitKeyOf(rate_limit_key, bucket_start);
		const existing = this.rateLimitItems.get(k);
		this.rateLimitItems.set(k, {
			rate_limit_key,
			bucket_start,
			count: (existing?.count ?? 0) + inc,
			ttl: existing?.ttl ?? ttl, // if_not_exists semantics
		});
	}

	private applyRateLimitQuery(command: QueryCommand): { Items: RateLimitItem[] } {
		const values = command.input.ExpressionAttributeValues ?? {};
		const key = values[':key'] as string;
		const hasRange = ':start' in values && ':end' in values;

		const matches = Array.from(this.rateLimitItems.values()).filter((item) => {
			if (item.rate_limit_key !== key) return false;
			if (!hasRange) return true;
			return item.bucket_start >= (values[':start'] as number) && item.bucket_start <= (values[':end'] as number);
		});

		return { Items: matches };
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
