import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { HarnessCredentialsStore } from './credentials-store';

function makeStore(): HarnessCredentialsStore {
	const fake = new FakeDynamoDocumentClient();
	return new HarnessCredentialsStore(fake as unknown as DynamoDBDocumentClient, 'test-identity');
}

describe('HarnessCredentialsStore', () => {
	it('defaults to platform_key for a user with no stored record', async () => {
		const store = makeStore();
		expect(await store.get('u1')).toEqual({ authMode: 'platform_key', updatedAt: 0 });
	});

	it('putEncryptedCredentials switches authMode to byo_credentials and stores the ciphertext', async () => {
		const store = makeStore();
		await store.putEncryptedCredentials('u1', 'ciphertext-base64');

		const record = await store.get('u1');
		expect(record.authMode).toBe('byo_credentials');
		expect(record.encryptedCredentials).toBe('ciphertext-base64');
		expect(record.updatedAt).toBeGreaterThan(0);
	});

	it('clear deletes the record entirely, reverting to the platform_key default', async () => {
		const store = makeStore();
		await store.putEncryptedCredentials('u1', 'ciphertext-base64');
		await store.clear('u1');

		expect(await store.get('u1')).toEqual({ authMode: 'platform_key', updatedAt: 0 });
	});

	it('scopes records independently per user', async () => {
		const store = makeStore();
		await store.putEncryptedCredentials('u1', 'u1-ciphertext');

		expect(await store.get('u1')).toMatchObject({ authMode: 'byo_credentials', encryptedCredentials: 'u1-ciphertext' });
		expect(await store.get('u2')).toEqual({ authMode: 'platform_key', updatedAt: 0 });
	});
});
