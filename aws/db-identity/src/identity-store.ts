/**
 * DynamoDB port of UserService and ApiKeyService — the identity slice
 * of D1 (worker/database/services/UserService.ts,
 * worker/database/services/ApiKeyService.ts), against the
 * `vibesdk-identity` table designed in docs/aws-dynamodb-schema.md.
 *
 * Corrects that schema doc in one real way, discovered by actually
 * writing this code rather than only designing on paper: the doc
 * modeled Session and API-key items nested under `USER#<userId>` with
 * hash-based lookup items for the hot auth paths (`SESSTOKEN#...`,
 * `APIKEYHASH#...`), but missed that `UserService.findValidSession`
 * and `ApiKeyService.getApiKeyById` both look up by the entity's own
 * ID directly, with no userId available to the caller at that point.
 * Two more lookup item types fix this: `SESSIONID#<id>` and
 * `APIKEYID#<id>`, both mapping to `{ userId }` so the nested item can
 * still be fetched in a second call. This is exactly the kind of gap a
 * paper design doesn't surface until something tries to actually call
 * the method that needs it.
 *
 * DynamoDB single-item conditional writes replace SQL's column-level
 * `UNIQUE` constraint, which doesn't exist across separate items here.
 * `createUser`, username changes, and `createApiKey` all use
 * `TransactWriteItems` with `attribute_not_exists` conditions on the
 * relevant lookup item(s) — this is what actually prevents two
 * concurrent registrations from claiming the same email/username, not
 * an application-level pre-check (which is racy on its own, same as it
 * would be against D1 without the real unique index backing it up).
 *
 * `cleanupExpiredSessions` is not ported — replaced by DynamoDB TTL on
 * the session item, the same pattern used in aws/rate-limit and
 * aws/secrets-vault.
 *
 * `getUserStatisticsBasic` (the one UserService method that queries the
 * `apps` table) is not ported here — it depends on AppService's own
 * DynamoDB port, which this package doesn't include.
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
	TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
	ApiKey,
	ApiKeyInfo,
	CreateApiKeyData,
	NewSession,
	NewUser,
	Session,
	User,
} from './types';
import {
	SK_LOOKUP,
	SK_PROFILE,
	apiKeyHashLookupPk,
	apiKeyIdLookupPk,
	apiKeySk,
	emailLookupPk,
	isConditionalCheckFailed,
	newId,
	oauthLookupPk,
	sessionIdLookupPk,
	sessionSk,
	stripStorageFields,
	userPk,
	usernameLookupPk,
} from './keys';

interface LookupItem {
	pk: string;
	sk: typeof SK_LOOKUP;
	userId: string;
	apiKeyId?: string;
}

export class UserStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	// ========================================
	// USER MANAGEMENT
	// ========================================

	/**
	 * `id` is normally generated internally. Callers may pass one
	 * explicitly when they need it before the write completes -- e.g.
	 * an email/password signup that self-references its own id as
	 * `providerId` (matching AuthService.register's original behavior,
	 * where `providerId: userId` is set at insert time).
	 */
	async createUser(userData: NewUser, id: string = newId()): Promise<User> {
		const now = Date.now();
		const user: User = {
			...userData,
			id,
			createdAt: userData.createdAt ?? now,
			updatedAt: userData.updatedAt ?? now,
		};

		const transactItems = [
			{
				Put: {
					TableName: this.tableName,
					Item: { pk: userPk(id), sk: SK_PROFILE, ...user },
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
			{
				Put: {
					TableName: this.tableName,
					Item: {
						pk: emailLookupPk(user.email),
						sk: SK_LOOKUP,
						userId: id,
					} satisfies LookupItem,
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
			{
				Put: {
					TableName: this.tableName,
					Item: {
						pk: oauthLookupPk(user.provider, user.providerId),
						sk: SK_LOOKUP,
						userId: id,
					} satisfies LookupItem,
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
			...(user.username
				? [
						{
							Put: {
								TableName: this.tableName,
								Item: {
									pk: usernameLookupPk(user.username),
									sk: SK_LOOKUP,
									userId: id,
								} satisfies LookupItem,
								ConditionExpression: 'attribute_not_exists(pk)',
							},
						},
					]
				: []),
		];

		await this.ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
		return user;
	}

	/**
	 * Simplified from the original: looks up by exactly one of
	 * id/email/provider, not a combined AND of whichever are given. Real
	 * call sites pass exactly one criterion; the original's flexible
	 * multi-criterion AND was never exercised with more than one filled
	 * in, as far as this port's callers go. Precedence when more than
	 * one is somehow supplied: id, then email, then provider.
	 */
	async findUser(options: {
		id?: string;
		email?: string;
		provider?: { name: string; id: string };
	}): Promise<User | null> {
		if (options.id) return this.getUserById(options.id);
		if (options.email) {
			const userId = await this.resolveLookup(emailLookupPk(options.email));
			return userId ? this.getUserById(userId) : null;
		}
		if (options.provider) {
			const userId = await this.resolveLookup(
				oauthLookupPk(options.provider.name, options.provider.id),
			);
			return userId ? this.getUserById(userId) : null;
		}
		return null;
	}

	async updateUserActivity(userId: string): Promise<void> {
		const now = Date.now();
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
				UpdateExpression: 'SET lastActiveAt = :now, updatedAt = :now',
				ExpressionAttributeValues: { ':now': now },
			}),
		);
	}

	async updateUserProfile(
		userId: string,
		profileData: {
			displayName?: string;
			username?: string;
			bio?: string;
			avatarUrl?: string;
			timezone?: string;
		},
	): Promise<void> {
		if (profileData.username !== undefined) {
			await this.reassignUsername(userId, profileData.username);
		}

		const { username: _username, ...rest } = profileData;
		const sets = Object.keys(rest).filter((k) => rest[k as keyof typeof rest] !== undefined);
		if (sets.length === 0 && profileData.username === undefined) return;

		const names: Record<string, string> = {};
		const values: Record<string, unknown> = { ':now': Date.now() };
		const setParts: string[] = ['updatedAt = :now'];
		for (const key of sets) {
			const alias = `#${key}`;
			names[alias] = key;
			values[`:${key}`] = rest[key as keyof typeof rest];
			setParts.push(`${alias} = :${key}`);
		}

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
				UpdateExpression: `SET ${setParts.join(', ')}`,
				ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
				ExpressionAttributeValues: values,
			}),
		);
	}

	/**
	 * Repoints the primary `provider`/`providerId` on the user row --
	 * separate from `updateUserProfile`, which only touches display
	 * fields, since this pair is also the OAuth-identity uniqueness
	 * lookup's key material at creation time and deserves its own
	 * explicit call site rather than being smuggled into a generic
	 * profile update. Added for `aws/auth-orchestration`'s
	 * `unlinkOAuthIdentity`, which needs it when the identity being
	 * removed was the "primary" one shown on the user row, and another
	 * identity remains to repoint to.
	 */
	async setPrimaryProvider(userId: string, provider: string, providerId: string): Promise<void> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
				UpdateExpression: 'SET provider = :provider, providerId = :providerId, updatedAt = :now',
				ExpressionAttributeValues: { ':provider': provider, ':providerId': providerId, ':now': Date.now() },
			}),
		);
	}

	async getAiGatewayPreference(
		userId: string,
	): Promise<{ enabled: boolean; isExplicit: boolean }> {
		const user = await this.getUserById(userId);
		if (!user) return { enabled: false, isExplicit: false };
		if (user.aiGatewayEnabled === null) {
			return { enabled: user.provider !== 'cloudflare', isExplicit: false };
		}
		return { enabled: user.aiGatewayEnabled, isExplicit: true };
	}

	async setAiGatewayPreference(userId: string, enabled: boolean): Promise<void> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
				UpdateExpression: 'SET aiGatewayEnabled = :enabled, updatedAt = :now',
				ExpressionAttributeValues: { ':enabled': enabled, ':now': Date.now() },
			}),
		);
	}

	async isUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
		const ownerId = await this.resolveLookup(usernameLookupPk(username));
		if (!ownerId) return true;
		return ownerId === excludeUserId;
	}

	async updateUserProfileWithValidation(
		userId: string,
		profileData: {
			username?: string;
			displayName?: string;
			bio?: string;
			theme?: 'light' | 'dark' | 'system';
		},
	): Promise<{ success: boolean; message: string }> {
		if (profileData.username) {
			const { username } = profileData;
			if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
				return {
					success: false,
					message: 'Username can only contain letters, numbers, underscores, and hyphens',
				};
			}
			if (username.length < 3 || username.length > 30) {
				return { success: false, message: 'Username must be between 3 and 30 characters' };
			}
			const reserved = [
				'admin', 'api', 'www', 'mail', 'ftp', 'root', 'support', 'help', 'about', 'terms', 'privacy',
			];
			if (reserved.includes(username.toLowerCase())) {
				return { success: false, message: 'Username is reserved' };
			}
			try {
				await this.reassignUsername(userId, username);
			} catch (err) {
				if (isConditionalCheckFailed(err)) {
					return { success: false, message: 'Username already taken' };
				}
				throw err;
			}
		}

		const sets: string[] = ['updatedAt = :now'];
		const values: Record<string, unknown> = { ':now': Date.now() };
		if (profileData.displayName) {
			sets.push('displayName = :displayName');
			values[':displayName'] = profileData.displayName;
		}
		if (profileData.bio) {
			sets.push('bio = :bio');
			values[':bio'] = profileData.bio;
		}
		if (profileData.theme) {
			sets.push('theme = :theme');
			values[':theme'] = profileData.theme;
		}

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
				UpdateExpression: `SET ${sets.join(', ')}`,
				ExpressionAttributeValues: values,
			}),
		);

		return { success: true, message: 'Profile updated successfully' };
	}

	// ========================================
	// SESSION MANAGEMENT
	// ========================================

	/**
	 * `id` is normally generated internally. Callers may pass one
	 * explicitly when they need the session id before the write
	 * completes -- e.g. to sign a JWT whose `sessionId` claim must match
	 * the persisted session's own id (matching AuthService's original
	 * behavior, where `SessionService.createSession` generates the id
	 * once and uses it for both).
	 */
	async createSession(sessionData: NewSession, id: string = newId()): Promise<Session> {
		const session: Session = {
			...sessionData,
			id,
			createdAt: sessionData.createdAt ?? Date.now(),
		};
		const ttlSeconds = Math.floor(session.expiresAt / 1000);

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: userPk(session.userId),
								sk: sessionSk(id),
								...session,
								ttl: ttlSeconds,
							},
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: sessionIdLookupPk(id),
								sk: SK_LOOKUP,
								userId: session.userId,
								ttl: ttlSeconds,
							} satisfies LookupItem & { ttl: number },
						},
					},
				],
			}),
		);
		return session;
	}

	async findValidSession(sessionId: string): Promise<Session | null> {
		const userId = await this.resolveLookup(sessionIdLookupPk(sessionId));
		if (!userId) return null;

		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: sessionSk(sessionId) },
			}),
		);
		const session = stripStorageFields(result.Item) as Session | undefined;
		if (!session) return null;
		if (session.expiresAt <= Date.now()) return null;
		return session;
	}

	// ========================================
	// INTERNAL
	// ========================================

	private async getUserById(userId: string): Promise<User | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_PROFILE },
			}),
		);
		return (stripStorageFields(result.Item) as User | undefined) ?? null;
	}

	private async resolveLookup(pk: string): Promise<string | null> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk, sk: SK_LOOKUP } }),
		);
		return (result.Item as LookupItem | undefined)?.userId ?? null;
	}

	/** Atomically releases the old username lookup (if any) and claims the new one. */
	private async reassignUsername(userId: string, newUsername: string): Promise<void> {
		const user = await this.getUserById(userId);
		const oldUsername = user?.username ?? null;

		const transactItems = [
			{
				Put: {
					TableName: this.tableName,
					Item: { pk: usernameLookupPk(newUsername), sk: SK_LOOKUP, userId } satisfies LookupItem,
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
			{
				Update: {
					TableName: this.tableName,
					Key: { pk: userPk(userId), sk: SK_PROFILE },
					UpdateExpression: 'SET username = :username, updatedAt = :now',
					ExpressionAttributeValues: { ':username': newUsername, ':now': Date.now() },
				},
			},
			...(oldUsername && oldUsername !== newUsername
				? [
						{
							Delete: {
								TableName: this.tableName,
								Key: { pk: usernameLookupPk(oldUsername), sk: SK_LOOKUP },
							},
						},
					]
				: []),
		];

		await this.ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
	}
}

export class ApiKeyStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async getUserApiKeys(userId: string): Promise<ApiKeyInfo[]> {
		const items = await this.queryUserKeys(userId);
		return items
			.map(toApiKeyInfo)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	async createApiKey(data: CreateApiKeyData): Promise<string> {
		const id = newId();
		const now = Date.now();
		const key: ApiKey = {
			id,
			userId: data.userId,
			name: data.name,
			keyHash: data.keyHash,
			keyPreview: data.keyPreview,
			scopes: JSON.stringify([]),
			isActive: true,
			lastUsed: null,
			requestCount: 0,
			expiresAt: null,
			createdAt: now,
			updatedAt: now,
		};

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: this.tableName,
							Item: { pk: userPk(data.userId), sk: apiKeySk(id), ...key },
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: apiKeyIdLookupPk(id),
								sk: SK_LOOKUP,
								userId: data.userId,
							} satisfies LookupItem,
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: apiKeyHashLookupPk(data.keyHash),
								sk: SK_LOOKUP,
								userId: data.userId,
								apiKeyId: id,
							} satisfies LookupItem,
							ConditionExpression: 'attribute_not_exists(pk)',
						},
					},
				],
			}),
		);

		return id;
	}

	async revokeApiKey(keyId: string, userId: string): Promise<boolean> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: apiKeySk(keyId) },
				UpdateExpression: 'SET isActive = :false, updatedAt = :now',
				ExpressionAttributeValues: { ':false': false, ':now': Date.now() },
			}),
		);
		return true;
	}

	async getApiKeyById(keyId: string): Promise<ApiKey | null> {
		const userId = await this.resolveLookup(apiKeyIdLookupPk(keyId));
		if (!userId) return null;
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: apiKeySk(keyId) },
			}),
		);
		return (stripStorageFields(result.Item) as ApiKey | undefined) ?? null;
	}

	async findApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
		const lookup = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: apiKeyHashLookupPk(keyHash), sk: SK_LOOKUP },
			}),
		);
		const item = lookup.Item as LookupItem | undefined;
		if (!item?.apiKeyId) return null;

		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(item.userId), sk: apiKeySk(item.apiKeyId) },
			}),
		);
		const key = stripStorageFields(result.Item) as ApiKey | undefined;
		if (!key || !key.isActive) return null;
		if (key.expiresAt !== null && key.expiresAt <= Date.now()) return null;
		return key;
	}

	async updateApiKeyLastUsed(keyId: string): Promise<void> {
		const userId = await this.resolveLookup(apiKeyIdLookupPk(keyId));
		if (!userId) return;
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: apiKeySk(keyId) },
				UpdateExpression:
					'SET lastUsed = :now, updatedAt = :now ADD requestCount :one',
				ExpressionAttributeValues: { ':now': Date.now(), ':one': 1 },
			}),
		);
	}

	async isApiKeyNameUnique(userId: string, name: string): Promise<boolean> {
		const items = await this.queryUserKeys(userId);
		return !items.some((k) => k.name === name && k.isActive);
	}

	async getActiveApiKeyCount(userId: string): Promise<number> {
		const items = await this.queryUserKeys(userId);
		return items.filter((k) => k.isActive).length;
	}

	private async resolveLookup(pk: string): Promise<string | null> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk, sk: SK_LOOKUP } }),
		);
		return (result.Item as LookupItem | undefined)?.userId ?? null;
	}

	private async queryUserKeys(userId: string): Promise<ApiKey[]> {
		const items: ApiKey[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'APIKEY#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(
				...(((page.Items as Record<string, unknown>[] | undefined) ?? []).map(
					(i) => stripStorageFields(i) as unknown as ApiKey,
				)),
			);
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);
		return items;
	}
}

function toApiKeyInfo(key: ApiKey): ApiKeyInfo {
	return {
		id: key.id,
		name: key.name,
		keyPreview: key.keyPreview,
		createdAt: key.createdAt,
		lastUsed: key.lastUsed,
		isActive: key.isActive,
	};
}
