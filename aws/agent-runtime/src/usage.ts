/**
 * Best-effort write side of vibesdk-db-llm-usage: records one item per
 * ./llm.ts / ./generation.ts `runInference` call, read back by
 * aws/user-api-lambda's GET /api/user/{id}/analytics and
 * GET /api/agent/{id}/analytics. A recording failure is logged and
 * swallowed -- it must never turn a successful (or already-failed) LLM
 * call into a harder failure for the user.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UsageStore, type RecordUsageParams } from 'vibesdk-db-llm-usage';

let cachedStore: UsageStore | null = null;

function getStore(): UsageStore {
	if (cachedStore) return cachedStore;
	const tableName = process.env.LLM_USAGE_TABLE;
	if (!tableName) throw new Error('LLM_USAGE_TABLE not configured');
	const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
	// Cast at the package boundary: vibesdk-db-llm-usage's own
	// independently-installed @aws-sdk/lib-dynamodb copy can drift to a
	// different patch version than this package's (both satisfy the
	// same ^3.600.0 range), which TS treats as structurally distinct
	// classes even though both are real DynamoDBDocumentClient
	// instances at runtime -- esbuild bundles each package
	// independently, so there's no actual runtime mismatch here.
	cachedStore = new UsageStore(ddb as unknown as ConstructorParameters<typeof UsageStore>[0], tableName);
	return cachedStore;
}

export async function recordUsage(params: RecordUsageParams): Promise<void> {
	try {
		await getStore().recordUsage(params);
	} catch (err) {
		console.error('Failed to record LLM usage', err);
	}
}
