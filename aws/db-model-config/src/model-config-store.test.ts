import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { ModelConfigStore, ModelProviderStore } from './model-config-store';

function makeStores(): {
	configs: ModelConfigStore;
	providers: ModelProviderStore;
	fake: FakeDynamoDocumentClient;
} {
	const fake = new FakeDynamoDocumentClient();
	const table = fake as unknown as DynamoDBDocumentClient;
	return {
		configs: new ModelConfigStore(table, 'test-model-config'),
		providers: new ModelProviderStore(table, 'test-model-config'),
		fake,
	};
}

describe('ModelConfigStore', () => {
	it('returns null for a config that has never been set', async () => {
		const { configs } = makeStores();
		expect(await configs.getUserModelConfig('u1', 'codeGeneration')).toBeNull();
	});

	it('creates a config on first upsert and updates it in place on the second', async () => {
		const { configs } = makeStores();

		const created = await configs.upsertUserModelConfig('u1', 'codeGeneration', {
			modelName: 'claude-opus',
			temperature: 0.7,
		});
		expect(created).toMatchObject({ modelName: 'claude-opus', temperature: 0.7, isActive: true });

		const updated = await configs.upsertUserModelConfig('u1', 'codeGeneration', {
			modelName: 'claude-sonnet',
		});
		// Same id and createdAt -- an update, not a second row.
		expect(updated.id).toBe(created.id);
		expect(updated.createdAt).toBe(created.createdAt);
		expect(updated.modelName).toBe('claude-sonnet');
		// Fields not passed on the second upsert reset to null (matches
		// the original's full-replace UPDATE semantics, not a partial
		// merge of only the fields that changed).
		expect(updated.temperature).toBeNull();
	});

	it('keeps two agent actions for the same user independent', async () => {
		const { configs } = makeStores();
		await configs.upsertUserModelConfig('u1', 'codeGeneration', { modelName: 'a' });
		await configs.upsertUserModelConfig('u1', 'planning', { modelName: 'b' });

		const all = await configs.getUserModelConfigs('u1');
		expect(all).toHaveLength(2);
		expect(all.map((c) => c.agentActionName).sort()).toEqual(['codeGeneration', 'planning']);
	});

	it('keeps two users fully isolated', async () => {
		const { configs } = makeStores();
		await configs.upsertUserModelConfig('alice', 'codeGeneration', { modelName: 'a' });

		expect(await configs.getUserModelConfig('bob', 'codeGeneration')).toBeNull();
	});

	it('deletes a config, and reports false deleting one that does not exist', async () => {
		const { configs } = makeStores();
		await configs.upsertUserModelConfig('u1', 'codeGeneration', { modelName: 'a' });

		expect(await configs.deleteUserModelConfig('u1', 'codeGeneration')).toBe(true);
		expect(await configs.getUserModelConfig('u1', 'codeGeneration')).toBeNull();
		expect(await configs.deleteUserModelConfig('u1', 'codeGeneration')).toBe(false);
	});

	it('resets all configs for a user and reports how many were removed', async () => {
		const { configs } = makeStores();
		await configs.upsertUserModelConfig('u1', 'codeGeneration', { modelName: 'a' });
		await configs.upsertUserModelConfig('u1', 'planning', { modelName: 'b' });

		const removed = await configs.resetAllUserConfigs('u1');
		expect(removed).toBe(2);
		expect(await configs.getUserModelConfigs('u1')).toEqual([]);
	});
});

describe('ModelProviderStore', () => {
	it('creates a provider and finds it by id and by name', async () => {
		const { providers } = makeStores();
		const created = await providers.createProvider('u1', {
			name: 'My Ollama',
			baseUrl: 'http://localhost:11434',
			secretId: 'secret-1',
		});

		expect(await providers.getProvider('u1', created.id)).toMatchObject({ name: 'My Ollama' });
		expect(await providers.getProviderByName('u1', 'My Ollama')).toMatchObject({ id: created.id });
	});

	it('reports provider existence by name', async () => {
		const { providers } = makeStores();
		await providers.createProvider('u1', { name: 'A', baseUrl: 'x', secretId: 's' });

		expect(await providers.providerExists('u1', 'A')).toBe(true);
		expect(await providers.providerExists('u1', 'B')).toBe(false);
	});

	it('rejects a duplicate provider name for the same user', async () => {
		const { providers } = makeStores();
		await providers.createProvider('u1', { name: 'dup', baseUrl: 'x', secretId: 's' });

		await expect(
			providers.createProvider('u1', { name: 'dup', baseUrl: 'y', secretId: 't' }),
		).rejects.toThrow();
	});

	it('allows the same provider name for two different users', async () => {
		const { providers } = makeStores();
		await providers.createProvider('alice', { name: 'shared', baseUrl: 'x', secretId: 's' });

		await expect(
			providers.createProvider('bob', { name: 'shared', baseUrl: 'y', secretId: 't' }),
		).resolves.toMatchObject({ name: 'shared' });
	});

	it('lists all providers for a user', async () => {
		const { providers } = makeStores();
		await providers.createProvider('u1', { name: 'A', baseUrl: 'x', secretId: 's' });
		await providers.createProvider('u1', { name: 'B', baseUrl: 'y', secretId: 't' });

		const list = await providers.getUserProviders('u1');
		expect(list.map((p) => p.name).sort()).toEqual(['A', 'B']);
		expect(await providers.getProviderCount('u1')).toBe(2);
	});

	it('renames a provider, releasing the old name and claiming the new one', async () => {
		const { providers } = makeStores();
		const created = await providers.createProvider('u1', { name: 'old', baseUrl: 'x', secretId: 's' });

		await providers.updateProvider('u1', created.id, { name: 'new' });

		expect(await providers.providerExists('u1', 'old')).toBe(false);
		expect(await providers.getProviderByName('u1', 'new')).toMatchObject({ id: created.id });
	});

	it('rejects renaming to a name already taken by another provider', async () => {
		const { providers } = makeStores();
		await providers.createProvider('u1', { name: 'taken', baseUrl: 'x', secretId: 's' });
		const other = await providers.createProvider('u1', { name: 'other', baseUrl: 'y', secretId: 't' });

		await expect(providers.updateProvider('u1', other.id, { name: 'taken' })).rejects.toThrow();
	});

	it('toggles active status', async () => {
		const { providers } = makeStores();
		const created = await providers.createProvider('u1', { name: 'A', baseUrl: 'x', secretId: 's' });
		expect(created.isActive).toBe(true);

		const toggled = await providers.toggleProviderStatus('u1', created.id);
		expect(toggled?.isActive).toBe(false);
	});

	it('deletes a provider and releases its name lookup', async () => {
		const { providers } = makeStores();
		const created = await providers.createProvider('u1', { name: 'A', baseUrl: 'x', secretId: 's' });

		expect(await providers.deleteProvider('u1', created.id)).toBe(true);
		expect(await providers.getProvider('u1', created.id)).toBeNull();
		expect(await providers.providerExists('u1', 'A')).toBe(false);

		// The freed name can be claimed again, by anyone.
		await expect(
			providers.createProvider('u1', { name: 'A', baseUrl: 'z', secretId: 'r' }),
		).resolves.toMatchObject({ name: 'A' });
	});

	it('returns false deleting or null updating a provider that does not exist', async () => {
		const { providers } = makeStores();
		expect(await providers.deleteProvider('u1', 'nope')).toBe(false);
		expect(await providers.updateProvider('u1', 'nope', { name: 'x' })).toBeNull();
		expect(await providers.toggleProviderStatus('u1', 'nope')).toBeNull();
	});
});
