/**
 * DynamoDB port of `ModelProvidersService` (full) and the storage layer
 * of `ModelConfigService` (partial — see below), against Table 4
 * (`vibesdk-model-config`) of docs/aws-dynamodb-schema.md — designed
 * there but not previously validated against real code.
 *
 * `ModelConfigService`'s merge-with-defaults and constraint-validation
 * logic (`mergeWithDefaults`, `applyConstraintsWithFallback`,
 * `validateModel`) is **not ported**. That logic imports `AGENT_CONFIG`/
 * `AGENT_CONSTRAINTS` from `worker/agents/inferutils/config` and a
 * constraint helper from `worker/api/controllers/modelConfig/`ic —
 * application/business logic that lives in the main codebase, not a
 * storage concern, and not something this package should duplicate (that
 * would drift from the real source over time). What's ported here is
 * the CRUD layer underneath it: read/write the raw stored config, same
 * as `getRawUserModelConfig`'s storage half. Merging with
 * `AGENT_CONFIG` defaults and constraint enforcement stay the caller's
 * job, same as `screenshotUrl` signing was left to the caller in
 * `aws/db-apps`.
 *
 * Both entities are always addressed by `(userId, key)` together in
 * every real call site (`getProvider(userId, providerId)`,
 * `getUserModelConfig(userId, agentActionName)`, etc.) — unlike
 * sessions/API keys/apps, nothing here needed a bare-ID lookup item.
 * `agentActionName` is already a stable per-user-unique key, so config
 * items need no separate lookup item at all. Providers have two
 * legitimate lookup axes (`getProvider` by ID, `getProviderByName` by
 * name) with a real uniqueness constraint on `(userId, name)`, so the
 * provider item is keyed by ID with a `TransactWriteItems`-backed name
 * lookup, same pattern as the identity table's username handling.
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
	CreateProviderData,
	UpdateProviderData,
	UpsertModelConfigData,
	UserModelConfig,
	UserModelProvider,
} from './types';

const userPk = (userId: string) => `USER#${userId}`;
const configSk = (agentActionName: string) => `MODELCONFIG#${agentActionName}`;
const providerSk = (id: string) => `MODELPROVIDER#${id}`;
const providerNameLookupSk = (name: string) => `MODELPROVIDERNAME#${name}`;

function newId(): string {
	return crypto.randomUUID();
}

function stripKeys<T extends Record<string, unknown>>(item: T): Omit<T, 'pk' | 'sk'> {
	const { pk: _pk, sk: _sk, ...rest } = item;
	return rest;
}

export class ModelConfigStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async getUserModelConfig(userId: string, agentActionName: string): Promise<UserModelConfig | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: configSk(agentActionName) },
			}),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as UserModelConfig;
	}

	async getUserModelConfigs(userId: string): Promise<UserModelConfig[]> {
		const items: UserModelConfig[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'MODELCONFIG#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(
				...(((page.Items as Record<string, unknown>[] | undefined) ?? []).map(
					(i) => stripKeys(i) as unknown as UserModelConfig,
				)),
			);
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);
		return items.filter((c) => c.isActive);
	}

	async upsertUserModelConfig(
		userId: string,
		agentActionName: string,
		config: UpsertModelConfigData,
	): Promise<UserModelConfig> {
		const existing = await this.getUserModelConfig(userId, agentActionName);
		const now = Date.now();
		const merged: UserModelConfig = {
			id: existing?.id ?? newId(),
			userId,
			agentActionName,
			modelName: config.modelName ?? null,
			maxTokens: config.maxTokens ?? null,
			temperature: config.temperature ?? null,
			reasoningEffort: config.reasoningEffort ?? null,
			providerOverride: config.providerOverride ?? null,
			fallbackModel: config.fallbackModel ?? null,
			isActive: true,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		await this.ddb.send(
			new PutCommand({
				TableName: this.tableName,
				Item: { pk: userPk(userId), sk: configSk(agentActionName), ...merged },
			}),
		);
		return merged;
	}

	async deleteUserModelConfig(userId: string, agentActionName: string): Promise<boolean> {
		const existing = await this.getUserModelConfig(userId, agentActionName);
		if (!existing) return false;
		await this.ddb.send(
			new DeleteCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: configSk(agentActionName) },
			}),
		);
		return true;
	}

	async resetAllUserConfigs(userId: string): Promise<number> {
		const configs = await this.getUserModelConfigs(userId);
		for (const config of configs) {
			await this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: userPk(userId), sk: configSk(config.agentActionName) },
				}),
			);
		}
		return configs.length;
	}
}

export class ModelProviderStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async providerExists(userId: string, name: string): Promise<boolean> {
		return (await this.resolveNameLookup(userId, name)) !== null;
	}

	async createProvider(userId: string, data: CreateProviderData): Promise<UserModelProvider> {
		const id = newId();
		const now = Date.now();
		const provider: UserModelProvider = {
			id,
			userId,
			name: data.name,
			baseUrl: data.baseUrl,
			secretId: data.secretId,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		};

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: this.tableName,
							Item: { pk: userPk(userId), sk: providerSk(id), ...provider },
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: userPk(userId),
								sk: providerNameLookupSk(data.name),
								providerId: id,
							},
							ConditionExpression: 'attribute_not_exists(pk)',
						},
					},
				],
			}),
		);
		return provider;
	}

	async getUserProviders(userId: string): Promise<UserModelProvider[]> {
		const items: UserModelProvider[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'MODELPROVIDER#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(
				...(((page.Items as Record<string, unknown>[] | undefined) ?? []).map(
					(i) => stripKeys(i) as unknown as UserModelProvider,
				)),
			);
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);
		return items;
	}

	async getProvider(userId: string, providerId: string): Promise<UserModelProvider | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: providerSk(providerId) },
			}),
		);
		if (!result.Item) return null;
		return stripKeys(result.Item) as UserModelProvider;
	}

	async getProviderByName(userId: string, name: string): Promise<UserModelProvider | null> {
		const providerId = await this.resolveNameLookup(userId, name);
		if (!providerId) return null;
		return this.getProvider(userId, providerId);
	}

	async updateProvider(
		userId: string,
		providerId: string,
		data: UpdateProviderData,
	): Promise<UserModelProvider | null> {
		const existing = await this.getProvider(userId, providerId);
		if (!existing) return null;

		const updated: UserModelProvider = {
			...existing,
			...data,
			updatedAt: Date.now(),
		};

		if (data.name && data.name !== existing.name) {
			await this.ddb.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: { pk: userPk(userId), sk: providerSk(providerId), ...updated },
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: {
									pk: userPk(userId),
									sk: providerNameLookupSk(data.name),
									providerId,
								},
								ConditionExpression: 'attribute_not_exists(pk)',
							},
						},
						{
							Delete: {
								TableName: this.tableName,
								Key: { pk: userPk(userId), sk: providerNameLookupSk(existing.name) },
							},
						},
					],
				}),
			);
		} else {
			await this.ddb.send(
				new PutCommand({
					TableName: this.tableName,
					Item: { pk: userPk(userId), sk: providerSk(providerId), ...updated },
				}),
			);
		}

		return updated;
	}

	async deleteProvider(userId: string, providerId: string): Promise<boolean> {
		const existing = await this.getProvider(userId, providerId);
		if (!existing) return false;

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Delete: {
							TableName: this.tableName,
							Key: { pk: userPk(userId), sk: providerSk(providerId) },
						},
					},
					{
						Delete: {
							TableName: this.tableName,
							Key: { pk: userPk(userId), sk: providerNameLookupSk(existing.name) },
						},
					},
				],
			}),
		);
		return true;
	}

	async toggleProviderStatus(userId: string, providerId: string): Promise<UserModelProvider | null> {
		const provider = await this.getProvider(userId, providerId);
		if (!provider) return null;
		return this.updateProvider(userId, providerId, { isActive: !provider.isActive });
	}

	async getProviderCount(userId: string): Promise<number> {
		return (await this.getUserProviders(userId)).length;
	}

	private async resolveNameLookup(userId: string, name: string): Promise<string | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: providerNameLookupSk(name) },
			}),
		);
		return (result.Item as { providerId?: string } | undefined)?.providerId ?? null;
	}
}
