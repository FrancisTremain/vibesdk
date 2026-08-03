/**
 * Per-user storage for the harness's auth mode: either the platform's
 * workspace-scoped Anthropic API key (default), or a user-uploaded
 * Claude Code OAuth credentials blob (the branching path from the
 * migration's harness-auth design decision -- see aws/agent-harness's
 * README). Stored as one more item type under the existing
 * `vibesdk-identity` table (pk USER#<id>) rather than a new table --
 * same single-table convention as UserStore/ApiKeyStore in
 * identity-store.ts.
 *
 * This class only stores/retrieves the ciphertext -- it never touches
 * KMS. Encryption happens in aws/user-api-lambda at upload time
 * (kms:Encrypt); decryption happens inside the harness Fargate task
 * itself at session-start time (kms:Decrypt, via its own task role),
 * so the plaintext credential is never seen by the orchestrator Lambda
 * or transits the control-plane's plain-HTTP channel -- see
 * aws/agent-harness/src/credentials-client.ts.
 */

import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { userPk, stripStorageFields, SK_HARNESS_CREDENTIALS } from './keys';

export type HarnessAuthMode = 'platform_key' | 'byo_credentials';

export interface HarnessCredentialsRecord {
	authMode: HarnessAuthMode;
	/** Base64 KMS ciphertext of the raw .credentials.json bytes. Only present when authMode is 'byo_credentials'. */
	encryptedCredentials?: string;
	updatedAt: number;
}

const DEFAULT_RECORD: HarnessCredentialsRecord = { authMode: 'platform_key', updatedAt: 0 };

export class HarnessCredentialsStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async get(userId: string): Promise<HarnessCredentialsRecord> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk: userPk(userId), sk: SK_HARNESS_CREDENTIALS } }),
		);
		return (stripStorageFields(result.Item) as HarnessCredentialsRecord | undefined) ?? DEFAULT_RECORD;
	}

	async putEncryptedCredentials(userId: string, encryptedCredentials: string): Promise<void> {
		const record: HarnessCredentialsRecord = { authMode: 'byo_credentials', encryptedCredentials, updatedAt: Date.now() };
		await this.ddb.send(
			new PutCommand({ TableName: this.tableName, Item: { pk: userPk(userId), sk: SK_HARNESS_CREDENTIALS, ...record } }),
		);
	}

	/** Reverts to the platform-key path -- deletes the stored ciphertext entirely rather than merely flipping a flag, so a cleared credential can never be read back. */
	async clear(userId: string): Promise<void> {
		await this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: userPk(userId), sk: SK_HARNESS_CREDENTIALS } }));
	}
}
