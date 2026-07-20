import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { VaultStore } from './vault-store';
import { SESSION_TIMEOUT_MS, STORAGE_LIMITS } from './vault-types';

function makeStore(): { store: VaultStore; fake: FakeDynamoDocumentClient } {
	const fake = new FakeDynamoDocumentClient();
	const store = new VaultStore(fake as unknown as DynamoDBDocumentClient, 'test-vault');
	return { store, fake };
}

// Same type-only cast as vault-store.ts's decryptVMK -- Web Crypto's
// BufferSource wants a Uint8Array<ArrayBuffer> specifically; every array
// here is always ArrayBuffer-backed at runtime.
function asBufferSource(u: Uint8Array): Uint8Array<ArrayBuffer> {
	return u as Uint8Array<ArrayBuffer>;
}

/** Real AES-256-GCM crypto matching the client-side protocol VaultStore assumes. */
async function generateVmkAndEncryptedSession() {
	const vmk = crypto.getRandomValues(new Uint8Array(32));
	const sk = crypto.getRandomValues(new Uint8Array(32));
	const nonce = crypto.getRandomValues(new Uint8Array(12));

	const skKey = await crypto.subtle.importKey('raw', asBufferSource(sk), { name: 'AES-GCM' }, false, [
		'encrypt',
	]);
	const encryptedVMK = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(nonce) }, skKey, asBufferSource(vmk)),
	);

	return { vmk, sk, nonce, encryptedVMK };
}

async function encryptSecretValue(vmk: Uint8Array, plaintext: string) {
	const vmkKey = await crypto.subtle.importKey('raw', asBufferSource(vmk), { name: 'AES-GCM' }, false, [
		'encrypt',
	]);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: asBufferSource(nonce) },
			vmkKey,
			new TextEncoder().encode(plaintext),
		),
	);
	return { encrypted, nonce };
}

function fakeEncryptedName(name: string) {
	// Not real encryption -- storeSecret/getSecret don't decrypt names,
	// they're opaque ciphertext blobs from the store's point of view.
	return {
		ciphertext: new TextEncoder().encode(name),
		nonce: crypto.getRandomValues(new Uint8Array(12)),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('vault lifecycle', () => {
	it('reports not existing before setup, existing after', async () => {
		const { store } = makeStore();
		expect(await store.getVaultStatus('u1')).toEqual({ exists: false });

		const setup = await store.setupVault('u1', {
			kdfAlgorithm: 'argon2id',
			kdfSalt: new Uint8Array([1, 2, 3]).buffer,
			verificationBlob: new Uint8Array([4, 5, 6]).buffer,
			verificationNonce: new Uint8Array([7, 8, 9]).buffer,
		});
		expect(setup).toBe(true);

		const status = await store.getVaultStatus('u1');
		expect(status).toEqual({
			exists: true,
			kdfAlgorithm: 'argon2id',
			hasRecoveryCodes: false,
		});
	});

	it('refuses to set up a vault that already exists', async () => {
		const { store } = makeStore();
		const request = {
			kdfAlgorithm: 'argon2id' as const,
			kdfSalt: new Uint8Array([1]).buffer,
			verificationBlob: new Uint8Array([2]).buffer,
			verificationNonce: new Uint8Array([3]).buffer,
		};
		expect(await store.setupVault('u1', request)).toBe(true);
		expect(await store.setupVault('u1', request)).toBe(false);
	});

	it('keeps two users fully isolated', async () => {
		const { store } = makeStore();
		await store.setupVault('u1', {
			kdfAlgorithm: 'argon2id',
			kdfSalt: new Uint8Array([1]).buffer,
			verificationBlob: new Uint8Array([2]).buffer,
			verificationNonce: new Uint8Array([3]).buffer,
		});
		expect(await store.getVaultStatus('u2')).toEqual({ exists: false });
	});
});

describe('session management', () => {
	it('is locked before initSession, unlocked after', async () => {
		const { store } = makeStore();
		expect(await store.isVaultUnlocked('u1')).toBe(false);

		await store.initSession('u1', new Uint8Array([1]), new Uint8Array([2]));
		expect(await store.isVaultUnlocked('u1')).toBe(true);
	});

	it('locks again after closeSession', async () => {
		const { store } = makeStore();
		await store.initSession('u1', new Uint8Array([1]), new Uint8Array([2]));
		await store.closeSession('u1');
		expect(await store.isVaultUnlocked('u1')).toBe(false);
	});

	it('expires after SESSION_TIMEOUT_MS of inactivity', async () => {
		const { store } = makeStore();
		await store.initSession('u1', new Uint8Array([1]), new Uint8Array([2]));

		vi.setSystemTime(new Date(Date.now() + SESSION_TIMEOUT_MS + 1000));

		expect(await store.isVaultUnlocked('u1')).toBe(false);
	});

	it('does not expire if touched within the timeout window (sliding expiry)', async () => {
		const { store } = makeStore();
		await store.initSession('u1', new Uint8Array([1]), new Uint8Array([2]));

		vi.setSystemTime(new Date(Date.now() + SESSION_TIMEOUT_MS - 1000));
		expect(await store.isVaultUnlocked('u1')).toBe(true); // touches it, extends TTL

		vi.setSystemTime(new Date(Date.now() + SESSION_TIMEOUT_MS - 1000));
		expect(await store.isVaultUnlocked('u1')).toBe(true);
	});

	it('never persists the session key in storage', async () => {
		const { store, fake } = makeStore();
		const { encryptedVMK, nonce, sk } = await generateVmkAndEncryptedSession();

		await store.initSession('u1', encryptedVMK, nonce);

		const item = fake.itemFor('USER#u1', 'VAULTSESSION');
		expect(item).toBeDefined();
		const values = Object.values(item!);
		// The raw session key must not appear anywhere in the persisted item.
		const skBytes = Array.from(sk);
		const anyValueContainsSk = values.some(
			(v) => v instanceof Uint8Array && Array.from(v).join(',') === skBytes.join(','),
		);
		expect(anyValueContainsSk).toBe(false);
		expect(Object.keys(item!).sort()).toEqual(
			['created_at', 'encrypted_vmk', 'last_accessed_at', 'nonce', 'pk', 'sk', 'ttl'].sort(),
		);
	});
});

describe('secret CRUD', () => {
	it('stores and retrieves a secret', async () => {
		const { store } = makeStore();
		const name = fakeEncryptedName('OPENAI_API_KEY');
		const id = await store.storeSecret('u1', {
			encryptedValue: new Uint8Array([1, 2, 3]).buffer,
			valueNonce: new Uint8Array([4, 5, 6]).buffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			metadata: { provider: 'openai' },
			secretType: 'secret',
		});

		const secret = await store.getSecret('u1', id);
		expect(secret).toMatchObject({
			id,
			metadata: { provider: 'openai' },
			secretType: 'secret',
		});
	});

	it('lists secrets newest first and excludes deleted ones', async () => {
		const { store } = makeStore();
		const name = fakeEncryptedName('x');
		const base = {
			encryptedValue: new Uint8Array([1]).buffer,
			valueNonce: new Uint8Array([1]).buffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			secretType: 'secret' as const,
		};

		const first = await store.storeSecret('u1', base);
		vi.setSystemTime(new Date(Date.now() + 1000));
		const second = await store.storeSecret('u1', base);

		let list = await store.listSecrets('u1');
		expect(list.map((s) => s.id)).toEqual([second, first]);

		await store.deleteSecret('u1', second);
		list = await store.listSecrets('u1');
		expect(list.map((s) => s.id)).toEqual([first]);
	});

	it('filters secrets by provider metadata', async () => {
		const { store } = makeStore();
		const name = fakeEncryptedName('x');
		const base = {
			encryptedValue: new Uint8Array([1]).buffer,
			valueNonce: new Uint8Array([1]).buffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			secretType: 'secret' as const,
		};
		await store.storeSecret('u1', { ...base, metadata: { provider: 'openai' } });
		await store.storeSecret('u1', { ...base, metadata: { provider: 'anthropic' } });

		const openaiOnly = await store.getSecretsByProvider('u1', 'openai');
		expect(openaiOnly).toHaveLength(1);
		expect(openaiOnly[0]!.metadata?.provider).toBe('openai');
	});

	it('updates a secret in place', async () => {
		const { store } = makeStore();
		const name = fakeEncryptedName('x');
		const id = await store.storeSecret('u1', {
			encryptedValue: new Uint8Array([1]).buffer,
			valueNonce: new Uint8Array([1]).buffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			secretType: 'secret',
		});

		const ok = await store.updateSecret('u1', id, { metadata: { provider: 'updated' } });
		expect(ok).toBe(true);

		const secret = await store.getSecret('u1', id);
		expect(secret?.metadata?.provider).toBe('updated');
	});

	it('rejects an oversized secret value', async () => {
		const { store } = makeStore();
		const name = fakeEncryptedName('x');
		const tooBig = new Uint8Array(STORAGE_LIMITS.MAX_SECRET_VALUE_SIZE + 1);

		await expect(
			store.storeSecret('u1', {
				encryptedValue: tooBig.buffer,
				valueNonce: new Uint8Array([1]).buffer,
				encryptedName: name.ciphertext.buffer as ArrayBuffer,
				nameNonce: name.nonce.buffer as ArrayBuffer,
				secretType: 'secret',
			}),
		).rejects.toThrow(/exceeds maximum size/);
	});

	it('returns false updating or deleting a secret that does not exist', async () => {
		const { store } = makeStore();
		expect(await store.deleteSecret('u1', 'nope')).toBe(false);
		expect(await store.updateSecret('u1', 'nope', { metadata: {} })).toBe(false);
	});
});

describe('requestSecret (end-to-end crypto)', () => {
	it('decrypts a secret given the correct session key', async () => {
		const { store } = makeStore();
		const { vmk, sk, nonce, encryptedVMK } = await generateVmkAndEncryptedSession();
		await store.initSession('u1', encryptedVMK, nonce);

		const plaintext = 'sk-super-secret-api-key';
		const { encrypted, nonce: valueNonce } = await encryptSecretValue(vmk, plaintext);
		const name = fakeEncryptedName('OPENAI_API_KEY');

		await store.storeSecret('u1', {
			encryptedValue: encrypted.buffer as ArrayBuffer,
			valueNonce: valueNonce.buffer as ArrayBuffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			metadata: { provider: 'openai' },
			secretType: 'secret',
		});

		const result = await store.requestSecret('u1', { provider: 'openai' }, sk);
		expect(result).toEqual({ success: true, value: plaintext });
	});

	it('fails decryption given the wrong session key', async () => {
		const { store } = makeStore();
		const { vmk, encryptedVMK, nonce } = await generateVmkAndEncryptedSession();
		await store.initSession('u1', encryptedVMK, nonce);

		const { encrypted, nonce: valueNonce } = await encryptSecretValue(vmk, 'secret-value');
		const name = fakeEncryptedName('x');
		await store.storeSecret('u1', {
			encryptedValue: encrypted.buffer as ArrayBuffer,
			valueNonce: valueNonce.buffer as ArrayBuffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			metadata: { provider: 'openai' },
			secretType: 'secret',
		});

		const wrongKey = crypto.getRandomValues(new Uint8Array(32));
		const result = await store.requestSecret('u1', { provider: 'openai' }, wrongKey);
		expect(result.success).toBe(false);
		expect(result.error).toBe('decryption_failed');
	});

	it('reports vault_locked when there is no active session', async () => {
		const { store } = makeStore();
		const sk = crypto.getRandomValues(new Uint8Array(32));
		const result = await store.requestSecret('u1', { provider: 'openai' }, sk);
		expect(result).toEqual({ success: false, error: 'vault_locked' });
	});

	it('reports invalid_request when no lookup criteria are given', async () => {
		const { store } = makeStore();
		const sk = crypto.getRandomValues(new Uint8Array(32));
		const result = await store.requestSecret('u1', {}, sk);
		expect(result).toEqual({ success: false, error: 'invalid_request' });
	});
});

describe('resetVault', () => {
	it('clears config, secrets, and session', async () => {
		const { store } = makeStore();
		await store.setupVault('u1', {
			kdfAlgorithm: 'argon2id',
			kdfSalt: new Uint8Array([1]).buffer,
			verificationBlob: new Uint8Array([2]).buffer,
			verificationNonce: new Uint8Array([3]).buffer,
		});
		await store.initSession('u1', new Uint8Array([1]), new Uint8Array([2]));
		const name = fakeEncryptedName('x');
		await store.storeSecret('u1', {
			encryptedValue: new Uint8Array([1]).buffer,
			valueNonce: new Uint8Array([1]).buffer,
			encryptedName: name.ciphertext.buffer as ArrayBuffer,
			nameNonce: name.nonce.buffer as ArrayBuffer,
			secretType: 'secret',
		});

		await store.resetVault('u1');

		expect(await store.getVaultStatus('u1')).toEqual({ exists: false });
		expect(await store.isVaultUnlocked('u1')).toBe(false);
		expect(await store.listSecrets('u1')).toEqual([]);
	});
});
