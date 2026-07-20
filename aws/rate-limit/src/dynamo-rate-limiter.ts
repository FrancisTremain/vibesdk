/**
 * DynamoDB-backed bucketed sliding-window rate limiter.
 *
 * Port of worker/services/rate-limit/DORateLimitStore.ts onto DynamoDB,
 * per docs/aws-migration-technical-design.md's component mapping
 * (`DORateLimitStore` -> "DynamoDB conditional-update token bucket").
 * Same algorithm and public result shape; the storage model changes in
 * one deliberate way, described below.
 *
 * Original design: one Durable Object per rate-limit key
 * (`env.DORateLimitStore.getByName(key)`), holding *all* of that key's
 * buckets as a single in-memory Map, persisted as one blob, with a
 * manual periodic sweep (`cleanup()`) to age out old buckets.
 *
 * This design: one DynamoDB item per (key, bucketStart) instead of one
 * blob per key holding every bucket. Two reasons, not just "because
 * DynamoDB":
 *   1. A DO's single-threaded actor guarantee made the original's
 *      read-Map-then-write-Map safe under concurrent calls for free.
 *      Nothing here provides that for free anymore (same actor-model gap
 *      as the rest of this migration) — so the bucket increment uses
 *      DynamoDB's atomic `ADD`, which doesn't need a read-modify-write
 *      round trip or a lock at all.
 *   2. Storing every bucket as one growing blob item means every
 *      increment rewrites the *entire* key's history, and the item can
 *      grow without bound for a hot key. Per-bucket items don't have
 *      that problem, and get automatic expiry via DynamoDB TTL —
 *      replacing the original's manual `cleanup()` sweep entirely.
 *
 * Not ported: `resetLimit()` with no key (the original's "clear every
 * bucket for every key globally" mode). No caller in the codebase uses
 * it, and it doesn't map onto DynamoDB's pay-per-request model without
 * a full table scan. `resetLimit(key)` — the actually-used shape — is
 * ported as-is.
 */

import {
	DynamoDBDocumentClient,
	QueryCommand,
	UpdateCommand,
	DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getStartOfUtcDay(nowMs: number): number {
	return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

export interface RateLimitConfig {
	limit: number;
	period: number; // seconds
	burst?: number;
	burstWindow?: number; // seconds
	bucketSize?: number; // seconds
	dailyLimit?: number; // max requests in a rolling (or calendar) 24h window
	/** If true, the main window is aligned to UTC calendar day (resets at midnight UTC). */
	calendarDaily?: boolean;
}

export interface RateLimitResult {
	success: boolean;
	remainingLimit?: number;
	exceededLimit?: 'main' | 'burst' | 'daily';
	limitValue?: number;
	periodSeconds?: number;
}

interface BucketItem {
	rate_limit_key: string;
	bucket_start: number;
	count: number;
	ttl: number;
}

const BUCKET_ITEM_TTL_SLACK_SECONDS = 60; // small buffer past the widest window before TTL reaps it

export class DynamoRateLimiter {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async increment(
		key: string,
		config: RateLimitConfig,
		incrementBy = 1,
	): Promise<RateLimitResult> {
		const now = Date.now();
		const windows = this.computeWindows(now, config);
		const buckets = await this.queryBuckets(key, windows.widestStart, now);

		const mainCount = sumSince(buckets, windows.mainStart);
		const burstCount = config.burst
			? sumSince(buckets, windows.burstStart)
			: 0;
		const dailyCount = config.dailyLimit
			? sumSince(buckets, windows.dailyStart)
			: 0;

		if (mainCount >= config.limit) {
			return {
				success: false,
				remainingLimit: 0,
				exceededLimit: 'main',
				limitValue: config.limit,
				periodSeconds: config.period,
			};
		}
		if (config.burst && burstCount >= config.burst) {
			return {
				success: false,
				remainingLimit: 0,
				exceededLimit: 'burst',
				limitValue: config.burst,
				periodSeconds: config.burstWindow,
			};
		}
		if (config.dailyLimit && dailyCount >= config.dailyLimit) {
			return {
				success: false,
				remainingLimit: 0,
				exceededLimit: 'daily',
				limitValue: config.dailyLimit,
				periodSeconds: 24 * 60 * 60,
			};
		}

		const bucketSizeMs = bucketSizeMsOf(config);
		const currentBucket = Math.floor(now / bucketSizeMs) * bucketSizeMs;
		const ttlEpochSeconds =
			Math.floor((now + windows.maxWindowMs) / 1000) +
			BUCKET_ITEM_TTL_SLACK_SECONDS;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { rate_limit_key: key, bucket_start: currentBucket },
				UpdateExpression:
					'SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :inc',
				ExpressionAttributeNames: { '#ttl': 'ttl', '#count': 'count' },
				ExpressionAttributeValues: {
					':ttl': ttlEpochSeconds,
					':inc': incrementBy,
				},
			}),
		);

		const mainRemaining = config.limit - mainCount - incrementBy;
		const dailyRemaining =
			config.dailyLimit != null
				? config.dailyLimit - dailyCount - incrementBy
				: undefined;
		const remaining =
			dailyRemaining != null
				? Math.min(mainRemaining, dailyRemaining)
				: mainRemaining;

		return { success: true, remainingLimit: Math.max(0, remaining) };
	}

	async getRemainingLimit(
		key: string,
		config: RateLimitConfig,
	): Promise<number> {
		const now = Date.now();
		const windows = this.computeWindows(now, config);
		const buckets = await this.queryBuckets(key, windows.widestStart, now);

		const mainCount = sumSince(buckets, windows.mainStart);
		const mainRemaining = config.limit - mainCount;

		if (config.dailyLimit) {
			const dailyCount = sumSince(buckets, windows.dailyStart);
			const dailyRemaining = config.dailyLimit - dailyCount;
			return Math.max(0, Math.min(mainRemaining, dailyRemaining));
		}

		return Math.max(0, mainRemaining);
	}

	/** Ported as-is; the original's no-argument "reset everything" mode is not (see module doc comment). */
	async resetLimit(key: string): Promise<void> {
		const items = await this.queryAllBucketsForKey(key);
		for (const item of items) {
			await this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { rate_limit_key: key, bucket_start: item.bucket_start },
				}),
			);
		}
	}

	private computeWindows(now: number, config: RateLimitConfig) {
		const mainWindowMs = config.period * 1000;
		const burstWindowMs = (config.burstWindow ?? 60) * 1000;
		const dailyWindowMs = config.dailyLimit ? MS_PER_DAY : 0;

		const mainStart = config.calendarDaily
			? getStartOfUtcDay(now)
			: now - mainWindowMs;
		const burstStart = now - burstWindowMs;
		const dailyStart = now - dailyWindowMs;

		const activeStarts = [mainStart];
		if (config.burst) activeStarts.push(burstStart);
		if (config.dailyLimit) activeStarts.push(dailyStart);

		const widestStart = Math.min(...activeStarts);
		const maxWindowMs = now - widestStart;

		return { mainStart, burstStart, dailyStart, widestStart, maxWindowMs };
	}

	private async queryBuckets(
		key: string,
		startMs: number,
		endMs: number,
	): Promise<BucketItem[]> {
		const items: BucketItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression:
						'rate_limit_key = :key AND bucket_start BETWEEN :start AND :end',
					ExpressionAttributeValues: {
						':key': key,
						':start': startMs,
						':end': endMs,
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...((page.Items as BucketItem[] | undefined) ?? []));
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);

		return items;
	}

	private async queryAllBucketsForKey(key: string): Promise<BucketItem[]> {
		const items: BucketItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const page = await this.ddb.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: 'rate_limit_key = :key',
					ExpressionAttributeValues: { ':key': key },
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...((page.Items as BucketItem[] | undefined) ?? []));
			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey);

		return items;
	}
}

function bucketSizeMsOf(config: RateLimitConfig): number {
	return (config.bucketSize ?? 10) * 1000;
}

function sumSince(buckets: BucketItem[], sinceMs: number): number {
	return buckets
		.filter((b) => b.bucket_start >= sinceMs)
		.reduce((sum, b) => sum + b.count, 0);
}
