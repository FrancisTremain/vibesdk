/**
 * DynamoDB port of `audit_logs` and `system_settings` — Tables 5 and 6
 * of docs/aws-dynamodb-schema.md, the two tables left unbuilt when
 * every other table's real caller got ported. Both are genuinely small:
 * `audit_logs` has exactly one real caller in the codebase
 * (`SessionService.logSecurityEvent`/`getUserSecurityStatus`, write +
 * read of `entityType: 'session'` rows); `system_settings` has none —
 * the only reference in `worker/database/database.ts` is a health-check
 * probe (`select().from(systemSettings).limit(1)`), no CRUD service
 * exists for it anywhere in the codebase. `SystemSettingsStore` below
 * is kept intentionally minimal (get/set on a key) rather than inventing
 * an API surface nothing currently calls.
 *
 * `AuditLogStore.listForUser` queries the `by-user` GSI design from the
 * schema doc — eventually consistent, which the schema doc already
 * calls out as acceptable here ("show this user's activity" tolerates
 * it, unlike the identity table's uniqueness lookups).
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AuditLog, NewAuditLog, SystemSetting } from './types';

function newId(): string {
	return crypto.randomUUID();
}
function stripKeys<T extends Record<string, unknown>>(item: T): Omit<T, 'pk' | 'sk' | 'gsi1pk' | 'gsi1sk'> {
	const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, ...rest } = item;
	return rest;
}

export class AuditLogStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async record(entry: NewAuditLog): Promise<AuditLog> {
		const createdAt = entry.createdAt ?? Date.now();
		const log: AuditLog = { ...entry, id: newId(), createdAt };

		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: `ENTITY#${log.entityType}#${log.entityId}`,
					sk: `LOG#${createdAt}#${log.id}`,
					...(log.userId ? { gsi1pk: log.userId, gsi1sk: createdAt } : {}),
					...log,
				},
			}),
		);
		return log;
	}

	/** All logged actions against one entity, most recent last (insertion order via SK). */
	async listForEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: 'pk = :pk',
				ExpressionAttributeValues: { ':pk': `ENTITY#${entityType}#${entityId}` },
			}),
		);
		return ((result.Items as Record<string, unknown>[] | undefined) ?? []).map(
			(i) => stripKeys(i) as unknown as AuditLog,
		);
	}

	/** A user's logged actions across all entities, optionally bounded to `sinceMs` onward. */
	async listForUser(userId: string, sinceMs?: number): Promise<AuditLog[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				IndexName: 'gsi1',
				KeyConditionExpression: 'gsi1pk = :pk',
				ExpressionAttributeValues: { ':pk': userId },
				ScanIndexForward: false,
			}),
		);
		const items = ((result.Items as Record<string, unknown>[] | undefined) ?? []).map(
			(i) => stripKeys(i) as unknown as AuditLog,
		);
		return sinceMs === undefined ? items : items.filter((i) => i.createdAt > sinceMs);
	}
}

export class SystemSettingsStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async get(key: string): Promise<SystemSetting | null> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk: `SETTING#${key}` } }),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as unknown as SystemSetting;
	}

	async set(key: string, value: unknown, updatedBy: string | null = null, description: string | null = null): Promise<SystemSetting> {
		const existing = await this.get(key);
		const setting: SystemSetting = {
			id: existing?.id ?? newId(),
			key,
			value,
			description: description ?? existing?.description ?? null,
			updatedAt: Date.now(),
			updatedBy,
		};
		await this.ddb.send(
			new PutCommand({ TableName: this.tableName, Item: { pk: `SETTING#${key}`, ...setting } }),
		);
		return setting;
	}
}
