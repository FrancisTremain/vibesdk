/**
 * DynamoDB port of the storage layer of `SessionService`
 * (worker/database/services/SessionService.ts, 509 lines) — extends
 * `identity-store.ts`'s Session handling in this same package, against
 * the same `vibesdk-identity` table, since sessions belong there.
 *
 * NOT PORTED:
 *   - `createSession`'s JWT logic (`JWTUtils.createAccessToken`,
 *     token hashing) — application/crypto logic that belongs to the
 *     caller, not this storage layer. `UserStore.createSession` in
 *     `identity-store.ts` already covers the storage half (persist a
 *     session with an already-computed `accessTokenHash`); the caller
 *     does token creation and hashing, then calls that.
 *   - `logSecurityEvent` and `getUserSecurityStatus` — both depend on
 *     the `audit_logs` table (Table 5, `vibesdk-audit-log`, in
 *     docs/aws-dynamodb-schema.md), which has no package built against
 *     it yet. Porting either here would mean inventing a fake
 *     audit-log read path; excluded instead, same as `db-analytics`
 *     excluded `batchGetAppStats` rather than fake `forkCount`.
 *   - `cleanupExpiredSessions` — replaced by DynamoDB TTL on the
 *     session item, same as everywhere else in this migration.
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { sessionSk, stripStorageFields, userPk } from './keys';
import type { Session } from './types';

/** Sessions per user beyond this many (oldest by lastActivity first) get pruned. */
const MAX_SESSIONS_PER_USER = 5;

export class SessionStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async revokeUserSession(sessionId: string, userId: string): Promise<void> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: sessionSk(sessionId) },
				UpdateExpression:
					'SET isRevoked = :true, revokedAt = :now, revokedReason = :reason',
				ExpressionAttributeValues: {
					':true': true,
					':now': Date.now(),
					':reason': 'user_logout',
				},
			}),
		);
	}

	async revokeAllUserSessions(userId: string): Promise<void> {
		const sessions = await this.getAllUserSessions(userId);
		for (const session of sessions) {
			await this.ddb.send(
				new UpdateCommand({
					TableName: this.tableName,
					Key: { pk: userPk(userId), sk: sessionSk(session.id) },
					UpdateExpression:
						'SET isRevoked = :true, revokedAt = :now, revokedReason = :reason',
					ExpressionAttributeValues: {
						':true': true,
						':now': Date.now(),
						':reason': 'user_force_logout',
					},
				}),
			);
		}
	}

	/** Ported as-is: revokes by session id alone, no userId check (matches
	 *  the original's `revokeSessionId` -- used by logout flows that only
	 *  have the token/session id in hand). Requires the SESSIONID# lookup
	 *  to find the owning user's partition. */
	async revokeSessionId(sessionId: string): Promise<void> {
		const session = await this.getSessionById(sessionId);
		if (!session) return; // Matches the original: never throws for logout.
		await this.revokeUserSession(sessionId, session.userId);
	}

	async getSessionCreatedAt(sessionId: string): Promise<number | null> {
		const session = await this.getSessionById(sessionId);
		return session?.createdAt ?? null;
	}

	async getSessionById(sessionId: string): Promise<Session | null> {
		const lookup = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: `SESSIONID#${sessionId}`, sk: 'LOOKUP' },
			}),
		);
		const userId = (lookup.Item as { userId?: string } | undefined)?.userId;
		if (!userId) return null;

		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: sessionSk(sessionId) },
			}),
		);
		return (stripStorageFields(result.Item) as Session | undefined) ?? null;
	}

	/** Active (non-revoked, non-expired) sessions, most recently active first. */
	async getUserSessions(userId: string): Promise<Session[]> {
		const now = Date.now();
		const sessions = await this.getAllUserSessions(userId);
		return sessions
			.filter((s) => !s.isRevoked && s.expiresAt > now)
			.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
	}

	/**
	 * Keeps only the `MAX_SESSIONS_PER_USER` most recently active
	 * sessions for a user, deleting the rest. Ported from
	 * `cleanupUserSessions`, called by the original at the start of
	 * every `createSession` -- the caller here is expected to call this
	 * the same way before creating a new session.
	 */
	async cleanupUserSessions(userId: string): Promise<number> {
		const sessions = await this.getAllUserSessions(userId);
		if (sessions.length <= MAX_SESSIONS_PER_USER) return 0;

		const sorted = sessions
			.slice()
			.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
		const toDelete = sorted.slice(MAX_SESSIONS_PER_USER);

		for (const session of toDelete) {
			await this.deleteSession(userId, session.id);
		}
		return toDelete.length;
	}

	/** Deletes every session for `userId` except `currentSessionId`. Returns the count removed. */
	async forceLogoutAllOtherSessions(userId: string, currentSessionId: string): Promise<number> {
		const sessions = await this.getAllUserSessions(userId);
		const others = sessions.filter((s) => s.id !== currentSessionId);
		for (const session of others) {
			await this.deleteSession(userId, session.id);
		}
		return others.length;
	}

	// ========================================
	// INTERNAL
	// ========================================

	private async getAllUserSessions(userId: string): Promise<Session[]> {
		const items: Session[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'SESSION#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(
				...(((page.Items as Record<string, unknown>[] | undefined) ?? []).map(
					(i) => stripStorageFields(i) as unknown as Session,
				)),
			);
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);
		return items;
	}

	private async deleteSession(userId: string, sessionId: string): Promise<void> {
		await Promise.all([
			this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: userPk(userId), sk: sessionSk(sessionId) },
				}),
			),
			this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: `SESSIONID#${sessionId}`, sk: 'LOOKUP' },
				}),
			),
		]);
	}
}
