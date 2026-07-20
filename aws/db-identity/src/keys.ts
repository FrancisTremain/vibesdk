/** Shared key-building helpers and small utilities used by both
 *  identity-store.ts and session-store.ts against the same
 *  `vibesdk-identity` table. */

export function userPk(userId: string): string {
	return `USER#${userId}`;
}
export const SK_PROFILE = 'PROFILE';
export const SK_LOOKUP = 'LOOKUP';
export const sessionSk = (id: string) => `SESSION#${id}`;
export const apiKeySk = (id: string) => `APIKEY#${id}`;
export const emailLookupPk = (email: string) => `EMAIL#${email}`;
export const usernameLookupPk = (username: string) => `USERNAME#${username}`;
export const oauthLookupPk = (provider: string, providerId: string) =>
	`OAUTHLOOKUP#${provider}#${providerId}`;
export const sessionIdLookupPk = (sessionId: string) => `SESSIONID#${sessionId}`;
export const apiKeyIdLookupPk = (keyId: string) => `APIKEYID#${keyId}`;
export const apiKeyHashLookupPk = (keyHash: string) => `APIKEYHASH#${keyHash}`;

export function newId(): string {
	return crypto.randomUUID();
}

/** Drops the DynamoDB storage-only fields (pk/sk/ttl) from a returned item. */
export function stripStorageFields(
	item: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!item) return undefined;
	const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = item;
	return rest;
}

export function isConditionalCheckFailed(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const name = (err as { name?: string }).name;
	if (name === 'ConditionalCheckFailedException') return true;
	// TransactWriteItems failures surface as TransactionCanceledException
	// with a CancellationReasons array; a ConditionalCheckFailed among
	// them means the same thing for our purposes.
	if (name === 'TransactionCanceledException') {
		const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
			.CancellationReasons;
		return (reasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
	}
	return false;
}
