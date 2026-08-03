import { describe, it, expect, vi } from 'vitest';
import { UserCredentialsClient } from './credentials-client';

function fakeDdb(item: Record<string, unknown> | undefined) {
	return { send: vi.fn().mockResolvedValue({ Item: item }) };
}

function fakeKms(plaintext: string | undefined) {
	return { send: vi.fn().mockResolvedValue({ Plaintext: plaintext ? Buffer.from(plaintext, 'utf-8') : undefined }) };
}

describe('UserCredentialsClient', () => {
	it('returns null when no item exists for the user', async () => {
		const client = new UserCredentialsClient('test-identity', fakeDdb(undefined) as never, fakeKms(undefined) as never);
		expect(await client.getCredentialsJson('user-1')).toBeNull();
	});

	it('returns null when authMode is platform_key', async () => {
		const client = new UserCredentialsClient(
			'test-identity',
			fakeDdb({ authMode: 'platform_key' }) as never,
			fakeKms(undefined) as never,
		);
		expect(await client.getCredentialsJson('user-1')).toBeNull();
	});

	it('decrypts and parses the stored ciphertext when authMode is byo_credentials', async () => {
		const credentialsJson = { claudeAiOauth: { refreshToken: 'rt-1' } };
		const ddb = fakeDdb({ authMode: 'byo_credentials', encryptedCredentials: Buffer.from('ciphertext').toString('base64') });
		const kms = fakeKms(JSON.stringify(credentialsJson));

		const client = new UserCredentialsClient('test-identity', ddb as never, kms as never);
		expect(await client.getCredentialsJson('user-1')).toEqual(credentialsJson);
	});

	it('returns null when byo_credentials but decryption yields no plaintext', async () => {
		const ddb = fakeDdb({ authMode: 'byo_credentials', encryptedCredentials: 'abc' });
		const kms = fakeKms(undefined);

		const client = new UserCredentialsClient('test-identity', ddb as never, kms as never);
		expect(await client.getCredentialsJson('user-1')).toBeNull();
	});
});
