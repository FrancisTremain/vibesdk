/**
 * Fetches and decrypts a user's uploaded Claude Code OAuth credentials
 * directly from AWS (DynamoDB GetItem + KMS Decrypt, both always TLS,
 * authenticated by this task's own IAM role -- see
 * aws/infra/harness/main.tf's harness_task_user_credentials policy).
 *
 * Deliberately NOT fetched by aws/harness-orchestrator-lambda and
 * forwarded over the control plane's plain-HTTP POST /start body: that
 * would put a live Anthropic account credential on a channel with no
 * TLS termination in front of it (see aws/infra/user-credentials.tf's
 * module comment). Only a userId reference crosses that channel;
 * the harness task pulls the plaintext itself.
 *
 * Storage layout matches aws/db-identity's HarnessCredentialsStore
 * (pk USER#<userId>, sk HARNESSCREDENTIALS) -- duplicated here rather
 * than depending on vibesdk-db-identity directly so this image doesn't
 * need to bundle a package built around DynamoDBDocumentClient's Put/
 * Update/Delete surface for what's ultimately one GetItem call.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';

interface HarnessCredentialsItem {
	authMode?: string;
	encryptedCredentials?: string;
}

export class UserCredentialsClient {
	private readonly ddb: DynamoDBDocumentClient;
	private readonly kms: Pick<KMSClient, 'send'>;

	constructor(
		private readonly identityTable: string,
		ddb: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
		kms: Pick<KMSClient, 'send'> = new KMSClient({}),
	) {
		this.ddb = ddb;
		this.kms = kms;
	}

	/** Returns the uploaded `.credentials.json` object (with its `claudeAiOauth` field), or null if this user is on the platform-key path or never uploaded credentials. */
	async getCredentialsJson(userId: string): Promise<Record<string, unknown> | null> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.identityTable, Key: { pk: `USER#${userId}`, sk: 'HARNESSCREDENTIALS' } }),
		);
		const item = result.Item as HarnessCredentialsItem | undefined;
		if (!item || item.authMode !== 'byo_credentials' || !item.encryptedCredentials) return null;

		const decrypted = await this.kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(item.encryptedCredentials, 'base64') }));
		if (!decrypted.Plaintext) return null;
		return JSON.parse(Buffer.from(decrypted.Plaintext).toString('utf-8'));
	}
}
