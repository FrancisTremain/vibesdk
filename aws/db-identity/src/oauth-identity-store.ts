/**
 * DynamoDB port of the storage half of `user_oauth_identities`
 * (worker/database/schema.ts) -- the multi-provider-linking table the
 * original `aws/db-identity` port didn't need yet, flagged in
 * docs/aws-dynamodb-schema.md as "still worth modeling for whenever
 * multi-provider linking is ported." That's now, driven by building
 * aws/auth-orchestration's account-linking flows
 * (linkOAuthIdentity/unlinkOAuthIdentity/completeOAuthLink in
 * worker/database/services/AuthService.ts), which are the first real
 * callers.
 *
 * Deliberately storage-only, same split as every other store in this
 * package: "is this (provider, providerId) already claimed, by whom"
 * and "attach/detach a row" live here; the account-takeover-prevention
 * policy (never implicitly bind by email, refuse to unlink a user's
 * last login method) lives in the orchestration layer that calls this.
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	QueryCommand,
	TransactWriteCommand,
	UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { NewOAuthIdentity, OAuthIdentity } from './types';
import { newId, oauthIdentitySk, oauthLookupPk, stripStorageFields, userPk } from './keys';

interface LookupItem {
	pk: string;
	sk: 'LOOKUP';
	userId: string;
}

export class OAuthIdentityStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	/**
	 * Attach a new identity to a user. Callers must check
	 * `findByProviderIdentity` first and decide what "already linked"
	 * means for their flow (refresh vs. reject) -- this always creates,
	 * and will silently overwrite an existing identity item + lookup for
	 * the same (provider, providerId) if one somehow already exists,
	 * since the write here isn't conditional. Use `refreshEmail` for the
	 * "already linked to this same user" case instead of calling this
	 * again.
	 */
	async link(data: NewOAuthIdentity): Promise<OAuthIdentity> {
		const now = Date.now();
		const identity: OAuthIdentity = {
			...data,
			id: newId(),
			createdAt: data.createdAt ?? now,
			updatedAt: data.updatedAt ?? now,
		};

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: userPk(identity.userId),
								sk: oauthIdentitySk(identity.provider, identity.providerId),
								...identity,
							},
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: {
								pk: oauthLookupPk(identity.provider, identity.providerId),
								sk: 'LOOKUP',
								userId: identity.userId,
							} satisfies LookupItem,
						},
					},
				],
			}),
		);

		return identity;
	}

	/** Refresh the cached email/verification on an already-linked identity. */
	async refreshEmail(
		userId: string,
		provider: string,
		providerId: string,
		email: string,
		emailVerified: boolean,
	): Promise<void> {
		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: oauthIdentitySk(provider, providerId) },
				UpdateExpression: 'SET email = :email, emailVerified = :verified, updatedAt = :now',
				ExpressionAttributeValues: { ':email': email, ':verified': emailVerified, ':now': Date.now() },
			}),
		);
	}

	/**
	 * Strongly-consistent lookup by (provider, providerId) -- the OAuth
	 * login hot path, which is exactly why this is a dedicated lookup
	 * item rather than a GSI (see docs/aws-dynamodb-schema.md).
	 */
	async findByProviderIdentity(provider: string, providerId: string): Promise<OAuthIdentity | null> {
		const lookup = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: oauthLookupPk(provider, providerId), sk: 'LOOKUP' },
			}),
		);
		const userId = (lookup.Item as LookupItem | undefined)?.userId;
		if (!userId) return null;

		const result = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: userPk(userId), sk: oauthIdentitySk(provider, providerId) },
			}),
		);
		return (stripStorageFields(result.Item) as OAuthIdentity | undefined) ?? null;
	}

	/** All identities linked to a user. */
	async listForUser(userId: string): Promise<OAuthIdentity[]> {
		const items: OAuthIdentity[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
					ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'OAUTH#' },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(
				...(((page.Items as Record<string, unknown>[] | undefined) ?? []).map(
					(i) => stripStorageFields(i) as unknown as OAuthIdentity,
				)),
			);
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);
		return items;
	}

	/** Detach an identity: deletes both the identity item and its lookup. */
	async unlink(userId: string, provider: string, providerId: string): Promise<void> {
		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Delete: {
							TableName: this.tableName,
							Key: { pk: userPk(userId), sk: oauthIdentitySk(provider, providerId) },
						},
					},
					{
						Delete: {
							TableName: this.tableName,
							Key: { pk: oauthLookupPk(provider, providerId), sk: 'LOOKUP' },
						},
					},
				],
			}),
		);
	}
}
