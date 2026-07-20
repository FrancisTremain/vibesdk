/**
 * Ported directly from worker/services/secrets/vault-types.ts. Pure
 * types and constants, no storage/session logic — nothing here needed
 * to change for the AWS port.
 */

export type KdfAlgorithm = 'argon2id' | 'webauthn-prf';
export type SecretType = 'secret';

/** Standardized metadata for secrets (stored as plaintext JSON). */
export interface SecretMetadata {
	provider?: string; // e.g., "openai", "anthropic", "google"
	envVarName?: string; // e.g., "OPENAI_API_KEY"
	[key: string]: unknown;
}

export interface Argon2Params {
	time: number;
	mem: number;
	parallelism: number;
}

export interface VaultConfig {
	kdfAlgorithm: KdfAlgorithm;
	kdfSalt: Uint8Array;
	kdfParams?: Argon2Params;
	prfCredentialId?: string;
	prfSalt?: Uint8Array;
	verificationBlob: Uint8Array;
	verificationNonce: Uint8Array;
	hasRecoveryCodes: boolean;
}

export interface VaultStatusResponse {
	exists: boolean;
	kdfAlgorithm?: KdfAlgorithm;
	hasRecoveryCodes?: boolean;
}

export interface SetupVaultRequest {
	kdfAlgorithm: KdfAlgorithm;
	kdfSalt: ArrayBuffer;
	kdfParams?: Argon2Params;
	prfCredentialId?: string;
	prfSalt?: ArrayBuffer;
	encryptedRecoveryCodes?: ArrayBuffer;
	recoveryCodesNonce?: ArrayBuffer;
	verificationBlob: ArrayBuffer;
	verificationNonce: ArrayBuffer;
}

export interface StoreSecretRequest {
	encryptedValue: ArrayBuffer;
	valueNonce: ArrayBuffer;
	encryptedName: ArrayBuffer;
	nameNonce: ArrayBuffer;
	metadata?: SecretMetadata;
	secretType: SecretType;
}

export interface EncryptedSecret {
	id: string;
	encryptedValue: Uint8Array;
	valueNonce: Uint8Array;
	encryptedName: Uint8Array;
	nameNonce: Uint8Array;
	metadata?: SecretMetadata;
	secretType: SecretType;
	createdAt: number;
	updatedAt: number;
}

export interface SecretListItem {
	id: string;
	encryptedName: Uint8Array;
	nameNonce: Uint8Array;
	metadata?: SecretMetadata;
	secretType: SecretType;
	createdAt: number;
	updatedAt: number;
}

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const STORAGE_LIMITS = {
	MAX_SECRET_VALUE_SIZE: 50 * 1024, // 50 KB
	MAX_SECRET_NAME_LENGTH: 200,
	MAX_METADATA_SIZE: 10 * 1024, // 10 KB
} as const;
