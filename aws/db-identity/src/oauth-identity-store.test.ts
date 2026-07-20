import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { OAuthIdentityStore } from './oauth-identity-store';

function makeStore(): OAuthIdentityStore {
	const fake = new FakeDynamoDocumentClient();
	return new OAuthIdentityStore(fake as unknown as DynamoDBDocumentClient, 'test-identity');
}

describe('OAuthIdentityStore', () => {
	it('links an identity and finds it by (provider, providerId)', async () => {
		const store = makeStore();
		const identity = await store.link({
			userId: 'u1',
			provider: 'github',
			providerId: 'gh-1',
			email: 'user@example.com',
			emailVerified: true,
		});

		expect(identity.id).toBeTruthy();

		const found = await store.findByProviderIdentity('github', 'gh-1');
		expect(found).toMatchObject({ userId: 'u1', provider: 'github', providerId: 'gh-1' });
	});

	it('returns null for an unlinked (provider, providerId)', async () => {
		const store = makeStore();
		expect(await store.findByProviderIdentity('github', 'nope')).toBeNull();
	});

	it('lists all identities linked to a user', async () => {
		const store = makeStore();
		await store.link({ userId: 'u1', provider: 'github', providerId: 'gh-1', email: null, emailVerified: false });
		await store.link({ userId: 'u1', provider: 'google', providerId: 'go-1', email: null, emailVerified: false });
		await store.link({ userId: 'u2', provider: 'github', providerId: 'gh-2', email: null, emailVerified: false });

		const identities = await store.listForUser('u1');
		expect(identities).toHaveLength(2);
		expect(identities.map((i) => i.provider).sort()).toEqual(['github', 'google']);
	});

	it('refreshes the cached email on an existing identity', async () => {
		const store = makeStore();
		await store.link({
			userId: 'u1',
			provider: 'github',
			providerId: 'gh-1',
			email: 'old@example.com',
			emailVerified: false,
		});

		await store.refreshEmail('u1', 'github', 'gh-1', 'new@example.com', true);

		const found = await store.findByProviderIdentity('github', 'gh-1');
		expect(found).toMatchObject({ email: 'new@example.com', emailVerified: true });
	});

	it('unlinks an identity, removing both the identity item and its lookup', async () => {
		const store = makeStore();
		await store.link({ userId: 'u1', provider: 'github', providerId: 'gh-1', email: null, emailVerified: false });

		await store.unlink('u1', 'github', 'gh-1');

		expect(await store.findByProviderIdentity('github', 'gh-1')).toBeNull();
		expect(await store.listForUser('u1')).toHaveLength(0);
	});

	it('keeps identities from other providers/users intact after an unlink', async () => {
		const store = makeStore();
		await store.link({ userId: 'u1', provider: 'github', providerId: 'gh-1', email: null, emailVerified: false });
		await store.link({ userId: 'u1', provider: 'google', providerId: 'go-1', email: null, emailVerified: false });

		await store.unlink('u1', 'github', 'gh-1');

		const remaining = await store.listForUser('u1');
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ provider: 'google' });
	});
});
