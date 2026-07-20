/**
 * DynamoDB-backed secrets vault: storage, session lifecycle, and
 * decryption. Port of the storage/session/crypto core of
 * worker/services/secrets/UserSecretsStore.ts, per
 * docs/aws-migration-technical-design.md decision 4.
 *
 * Security model (unchanged from the original, restated here since it's
 * the whole point of this class):
 *   - VMK (Vault Master Key): derived client-side, never sent to or
 *     stored on the server in plaintext.
 *   - SK (Session Key): random per-session, held by the client.
 *   - encryptedVMK = AES-GCM(SK, VMK): safe to store server-side, since
 *     it's useless without the client-held SK.
 *   - "DB dump = useless encrypted blobs. Server needs the client's SK
 *     to decrypt anything."
 *
 * What changed, and why — this is the one place in the whole migration
 * where the Lambda model is a genuine improvement, not just a
 * workaround:
 *
 * The original holds `encryptedVMK` AND the session key `sk` together
 * in one Durable Object's memory for the session's lifetime. That's
 * safe there specifically because DO memory is never persisted or
 * dumped. Under the earlier (rejected) Fargate-pool design, preserving
 * that would have meant pinning a session to one worker process, since
 * `sk` living in a request-scoped Lambda invocation's memory doesn't
 * survive between invocations the way DO memory does.
 *
 * This class does NOT persist `sk` anywhere — not in DynamoDB, not
 * across invocations. `encryptedVMK` + its nonce persist in DynamoDB
 * (safe: ciphertext, TTL'd to match `SESSION_TIMEOUT_MS`) via
 * `initSession`. Every operation that actually needs to decrypt
 * something (`requestSecret`) requires the caller to pass `sessionKey`
 * in that same call — the API Gateway Lambda handler is responsible for
 * getting it from the client's request, not from anything stored here.
 * `sessionKey` is used in-memory for the duration of that one call and
 * discarded. The "DB dump = useless blobs" property holds exactly as
 * strongly as before, and no worker pinning is needed to make it true.
 *
 * Deliberately not ported: the WebSocket ticket manager
 * (`storeWsTicket`/`consumeWsTicket`). That's Cloudflare WS-upgrade-
 * specific connection auth, and its AWS equivalent (an API Gateway
 * WebSocket `$connect` authorizer) is a different mechanism needing its
 * own design — not a storage/crypto concern, so out of scope here.
 * Also not ported: the literal WebSocket message-routing handlers
 * (`handleStoreSecret` etc.) — those are API Gateway/Lambda glue that
 * calls into this class's methods; this class is the reusable, testable
 * core, matching how aws/actor-spike and aws/git-storage were scoped.
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
	type Argon2Params,
	type EncryptedSecret,
	type KdfAlgorithm,
	type SecretListItem,
	type SecretMetadata,
	type SecretType,
	type SetupVaultRequest,
	type StoreSecretRequest,
	type VaultConfig,
	type VaultStatusResponse,
	SESSION_TIMEOUT_MS,
	STORAGE_LIMITS,
} from './vault-types';

const SK_CONFIG = 'VAULTCONFIG';
const SK_SESSION = 'VAULTSESSION';
const secretSk = (id: string) => `SECRET#${id}`;
const secretIdFromSk = (sk: string) => sk.slice('SECRET#'.length);

function userPk(userId: string): string {
	return `USER#${userId}`;
}

interface VaultConfigItem {
	pk: string;
	sk: typeof SK_CONFIG;
	kdf_algorithm: KdfAlgorithm;
	kdf_salt: Uint8Array;
	kdf_params?: Argon2Params;
	prf_credential_id?: string;
	prf_salt?: Uint8Array;
	encrypted_recovery_codes?: Uint8Array;
	recovery_codes_nonce?: Uint8Array;
	verification_blob: Uint8Array;
	verification_nonce: Uint8Array;
	created_at: number;
	updated_at: number;
}

interface VaultSessionItem {
	pk: string;
	sk: typeof SK_SESSION;
	encrypted_vmk: Uint8Array;
	nonce: Uint8Array;
	created_at: number;
	last_accessed_at: number;
	ttl: number;
}

interface SecretItem {
	pk: string;
	sk: string;
	encrypted_value: Uint8Array;
	value_nonce: Uint8Array;
	encrypted_name: Uint8Array;
	name_nonce: Uint8Array;
	metadata?: SecretMetadata;
	secret_type: SecretType;
	created_at: number;
	updated_at: number;
	is_deleted: boolean;
}

export type SessionValidation =
	| { valid: true }
	| { valid: false; error: string; errorType: 'vault_locked' | 'session_expired' };

export class VaultStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	// ========== VAULT LIFECYCLE ==========

	async getVaultStatus(userId: string): Promise<VaultStatusResponse> {
		const config = await this.readConfig(userId);
		if (!config) return { exists: false };
		return {
			exists: true,
			kdfAlgorithm: config.kdf_algorithm,
			hasRecoveryCodes: config.encrypted_recovery_codes !== undefined,
		};
	}

	async getVaultConfig(userId: string): Promise<VaultConfig | null> {
		const config = await this.readConfig(userId);
		if (!config) return null;
		return {
			kdfAlgorithm: config.kdf_algorithm,
			kdfSalt: config.kdf_salt,
			kdfParams: config.kdf_params,
			prfCredentialId: config.prf_credential_id,
			prfSalt: config.prf_salt,
			verificationBlob: config.verification_blob,
			verificationNonce: config.verification_nonce,
			hasRecoveryCodes: config.encrypted_recovery_codes !== undefined,
		};
	}

	async setupVault(userId: string, request: SetupVaultRequest): Promise<boolean> {
		const existing = await this.readConfig(userId);
		if (existing) return false; // vault already exists

		const now = Date.now();
		const item: VaultConfigItem = {
			pk: userPk(userId),
			sk: SK_CONFIG,
			kdf_algorithm: request.kdfAlgorithm,
			kdf_salt: new Uint8Array(request.kdfSalt),
			...(request.kdfParams ? { kdf_params: request.kdfParams } : {}),
			...(request.prfCredentialId ? { prf_credential_id: request.prfCredentialId } : {}),
			...(request.prfSalt ? { prf_salt: new Uint8Array(request.prfSalt) } : {}),
			...(request.encryptedRecoveryCodes
				? { encrypted_recovery_codes: new Uint8Array(request.encryptedRecoveryCodes) }
				: {}),
			...(request.recoveryCodesNonce
				? { recovery_codes_nonce: new Uint8Array(request.recoveryCodesNonce) }
				: {}),
			verification_blob: new Uint8Array(request.verificationBlob),
			verification_nonce: new Uint8Array(request.verificationNonce),
			created_at: now,
			updated_at: now,
		};

		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
		return true;
	}

	async resetVault(userId: string): Promise<void> {
		await this.closeSession(userId);

		const secrets = await this.querySecrets(userId, { includeDeleted: true });
		for (const s of secrets) {
			await this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: userPk(userId), sk: s.sk },
				}),
			);
		}
		await this.ddb.send(
			new DeleteCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_CONFIG },
			}),
		);
	}

	// ========== SESSION MANAGEMENT ==========
	//
	// Only encryptedVMK + nonce are persisted — never the session key.
	// See the module-level doc comment.

	async initSession(
		userId: string,
		encryptedVMK: Uint8Array,
		nonce: Uint8Array,
	): Promise<void> {
		const now = Date.now();
		const item: VaultSessionItem = {
			pk: userPk(userId),
			sk: SK_SESSION,
			encrypted_vmk: encryptedVMK,
			nonce,
			created_at: now,
			last_accessed_at: now,
			ttl: Math.floor((now + SESSION_TIMEOUT_MS) / 1000),
		};
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
	}

	async closeSession(userId: string): Promise<void> {
		await this.ddb.send(
			new DeleteCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_SESSION },
			}),
		);
	}

	async isVaultUnlocked(userId: string): Promise<boolean> {
		return (await this.validateAndRefreshSession(userId)).valid;
	}

	/**
	 * Checks the session exists and isn't expired; if valid, extends its
	 * TTL (sliding expiry, matching the original's `lastAccessedAt`
	 * refresh-on-every-touch behavior). This costs a write on every call,
	 * unlike the original's free in-memory field update — acceptable
	 * given DynamoDB's per-request pricing, but worth noting as a real
	 * cost difference from the DO version, not a free port.
	 */
	async validateAndRefreshSession(userId: string): Promise<SessionValidation> {
		const session = await this.readSession(userId);
		if (!session) {
			return { valid: false, error: 'Vault is locked', errorType: 'vault_locked' };
		}
		const now = Date.now();
		if (now - session.last_accessed_at > SESSION_TIMEOUT_MS) {
			await this.closeSession(userId);
			return { valid: false, error: 'Session expired', errorType: 'session_expired' };
		}

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_SESSION },
				UpdateExpression: 'SET last_accessed_at = :now, #ttl = :ttl',
				ExpressionAttributeNames: { '#ttl': 'ttl' },
				ExpressionAttributeValues: {
					':now': now,
					':ttl': Math.floor((now + SESSION_TIMEOUT_MS) / 1000),
				},
			}),
		);
		return { valid: true };
	}

	// ========== SECRET OPERATIONS ==========

	async storeSecret(userId: string, request: StoreSecretRequest): Promise<string> {
		const limitError = validateStorageLimits(request.encryptedValue, request.encryptedName);
		if (limitError) throw new Error(limitError);

		const id = crypto.randomUUID();
		const now = Date.now();
		const item: SecretItem = {
			pk: userPk(userId),
			sk: secretSk(id),
			encrypted_value: new Uint8Array(request.encryptedValue),
			value_nonce: new Uint8Array(request.valueNonce),
			encrypted_name: new Uint8Array(request.encryptedName),
			name_nonce: new Uint8Array(request.nameNonce),
			...(request.metadata ? { metadata: request.metadata } : {}),
			secret_type: request.secretType,
			created_at: now,
			updated_at: now,
			is_deleted: false,
		};
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
		return id;
	}

	async getSecret(userId: string, secretId: string): Promise<EncryptedSecret | null> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: secretSk(secretId) },
			}),
		);
		const item = result.Item as SecretItem | undefined;
		if (!item || item.is_deleted) return null;
		return toEncryptedSecret(item);
	}

	async listSecrets(userId: string): Promise<SecretListItem[]> {
		const items = await this.querySecrets(userId, { includeDeleted: false });
		return items
			.map(toSecretListItem)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	async getSecretsByProvider(userId: string, provider: string): Promise<SecretListItem[]> {
		const secrets = await this.listSecrets(userId);
		return secrets.filter((s) => s.metadata?.provider === provider);
	}

	async deleteSecret(userId: string, secretId: string): Promise<boolean> {
		const existing = await this.getSecret(userId, secretId);
		if (!existing) return false;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: secretSk(secretId) },
				UpdateExpression: 'SET is_deleted = :true, updated_at = :now',
				ExpressionAttributeValues: { ':true': true, ':now': Date.now() },
			}),
		);
		return true;
	}

	async updateSecret(
		userId: string,
		secretId: string,
		update: {
			encryptedValue?: ArrayBuffer;
			valueNonce?: ArrayBuffer;
			encryptedName?: ArrayBuffer;
			nameNonce?: ArrayBuffer;
			metadata?: SecretMetadata;
		},
	): Promise<boolean> {
		const limitError = validateStorageLimits(update.encryptedValue, update.encryptedName);
		if (limitError) throw new Error(limitError);

		const existing = await this.getSecret(userId, secretId);
		if (!existing) return false;

		const sets: string[] = ['updated_at = :now'];
		const values: Record<string, unknown> = { ':now': Date.now() };

		if (update.encryptedValue && update.valueNonce) {
			sets.push('encrypted_value = :ev', 'value_nonce = :vn');
			values[':ev'] = new Uint8Array(update.encryptedValue);
			values[':vn'] = new Uint8Array(update.valueNonce);
		}
		if (update.encryptedName && update.nameNonce) {
			sets.push('encrypted_name = :en', 'name_nonce = :nn');
			values[':en'] = new Uint8Array(update.encryptedName);
			values[':nn'] = new Uint8Array(update.nameNonce);
		}
		if (update.metadata !== undefined) {
			sets.push('metadata = :md');
			values[':md'] = update.metadata;
		}

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: secretSk(secretId) },
				UpdateExpression: `SET ${sets.join(', ')}`,
				ExpressionAttributeValues: values,
			}),
		);
		return true;
	}

	// ========== RECOVERY CODES ==========

	async getEncryptedRecoveryCodes(
		userId: string,
	): Promise<{ encrypted: Uint8Array; nonce: Uint8Array } | null> {
		const config = await this.readConfig(userId);
		if (!config?.encrypted_recovery_codes || !config.recovery_codes_nonce) return null;
		return { encrypted: config.encrypted_recovery_codes, nonce: config.recovery_codes_nonce };
	}

	async updateRecoveryCodes(
		userId: string,
		encrypted: ArrayBuffer,
		nonce: ArrayBuffer,
	): Promise<boolean> {
		const config = await this.readConfig(userId);
		if (!config) return false;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_CONFIG },
				UpdateExpression:
					'SET encrypted_recovery_codes = :er, recovery_codes_nonce = :rn, updated_at = :now',
				ExpressionAttributeValues: {
					':er': new Uint8Array(encrypted),
					':rn': new Uint8Array(nonce),
					':now': Date.now(),
				},
			}),
		);
		return true;
	}

	// ========== DECRYPTION (agent-facing RPC equivalent) ==========
	//
	// `sessionKey` is supplied by the caller on every call -- see the
	// module-level doc comment for why this class never stores it.

	async requestSecret(
		userId: string,
		query: { provider?: string; envVarName?: string; secretId?: string },
		sessionKey: Uint8Array,
	): Promise<{ success: boolean; value?: string; error?: string }> {
		if (!query.provider && !query.envVarName && !query.secretId) {
			return { success: false, error: 'invalid_request' };
		}

		const validation = await this.validateAndRefreshSession(userId);
		if (!validation.valid) {
			return { success: false, error: validation.errorType };
		}

		let secretId = query.secretId;
		if (!secretId) {
			const matches = (await this.listSecrets(userId)).filter((s) => {
				if (query.provider && s.metadata?.provider !== query.provider) return false;
				if (query.envVarName && s.metadata?.envVarName !== query.envVarName) return false;
				return true;
			});
			if (matches.length === 0) return { success: false, error: 'secret_not_found' };
			secretId = matches[0]!.id;
		}

		const secret = await this.getSecret(userId, secretId);
		if (!secret) return { success: false, error: 'secret_not_found' };

		const session = await this.readSession(userId);
		if (!session) return { success: false, error: 'vault_locked' };

		try {
			const vmk = await decryptVMK(session.encrypted_vmk, session.nonce, sessionKey);
			const value = await decryptSecretValue(secret.encryptedValue, secret.valueNonce, vmk);
			return { success: true, value };
		} catch {
			return { success: false, error: 'decryption_failed' };
		}
	}

	async requestSecretByProvider(
		userId: string,
		provider: string,
		sessionKey: Uint8Array,
	): Promise<{ success: boolean; value?: string; error?: string }> {
		return this.requestSecret(userId, { provider }, sessionKey);
	}

	// ========== INTERNAL ==========

	private async readConfig(userId: string): Promise<VaultConfigItem | undefined> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_CONFIG },
			}),
		);
		return result.Item as VaultConfigItem | undefined;
	}

	private async readSession(userId: string): Promise<VaultSessionItem | undefined> {
		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: SK_SESSION },
			}),
		);
		return result.Item as VaultSessionItem | undefined;
	}

	private async querySecrets(
		userId: string,
		options: { includeDeleted: boolean },
	): Promise<SecretItem[]> {
		const items: SecretItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'SECRET#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...((page.Items as SecretItem[] | undefined) ?? []));
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);

		return options.includeDeleted ? items : items.filter((i) => !i.is_deleted);
	}
}

function toEncryptedSecret(item: SecretItem): EncryptedSecret {
	return {
		id: secretIdFromSk(item.sk),
		encryptedValue: item.encrypted_value,
		valueNonce: item.value_nonce,
		encryptedName: item.encrypted_name,
		nameNonce: item.name_nonce,
		metadata: item.metadata,
		secretType: item.secret_type,
		createdAt: item.created_at,
		updatedAt: item.updated_at,
	};
}

function toSecretListItem(item: SecretItem): SecretListItem {
	return {
		id: secretIdFromSk(item.sk),
		encryptedName: item.encrypted_name,
		nameNonce: item.name_nonce,
		metadata: item.metadata,
		secretType: item.secret_type,
		createdAt: item.created_at,
		updatedAt: item.updated_at,
	};
}

function validateStorageLimits(
	encryptedValue?: ArrayBuffer,
	encryptedName?: ArrayBuffer,
): string | null {
	if (encryptedValue && encryptedValue.byteLength > STORAGE_LIMITS.MAX_SECRET_VALUE_SIZE) {
		return `Secret value exceeds maximum size of ${STORAGE_LIMITS.MAX_SECRET_VALUE_SIZE / 1024}KB`;
	}
	if (encryptedName && encryptedName.byteLength > STORAGE_LIMITS.MAX_SECRET_NAME_LENGTH) {
		return `Secret name exceeds maximum length of ${STORAGE_LIMITS.MAX_SECRET_NAME_LENGTH} characters`;
	}
	return null;
}

/** Ported as-is from UserSecretsStore -- Web Crypto works identically on Node 20's Lambda runtime. */
async function decryptVMK(
	encryptedVMK: Uint8Array,
	nonce: Uint8Array,
	sessionKey: Uint8Array,
): Promise<CryptoKey> {
	// Web Crypto's BufferSource type wants a Uint8Array<ArrayBuffer> specifically;
	// every array here is always ArrayBuffer-backed at runtime (never a
	// SharedArrayBuffer), so this is a type-only cast, not a real conversion.
	const asBufferSource = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

	const sk = await crypto.subtle.importKey(
		'raw',
		asBufferSource(sessionKey),
		{ name: 'AES-GCM' },
		false,
		['decrypt'],
	);
	const vmkRaw = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: asBufferSource(nonce) },
		sk,
		asBufferSource(encryptedVMK),
	);
	const vmkArray = new Uint8Array(vmkRaw);
	const vmk = await crypto.subtle.importKey('raw', vmkArray, { name: 'AES-GCM' }, false, [
		'decrypt',
	]);
	vmkArray.fill(0);
	return vmk;
}

/** Ported as-is from UserSecretsStore. */
async function decryptSecretValue(
	encryptedValue: Uint8Array,
	nonce: Uint8Array,
	vmk: CryptoKey,
): Promise<string> {
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
		vmk,
		encryptedValue as Uint8Array<ArrayBuffer>,
	);
	const arr = new Uint8Array(plaintext);
	const result = new TextDecoder().decode(arr);
	arr.fill(0);
	return result;
}
