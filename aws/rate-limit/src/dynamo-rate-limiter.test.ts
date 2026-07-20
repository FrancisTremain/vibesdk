import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { DynamoRateLimiter, type RateLimitConfig } from './dynamo-rate-limiter';

function makeLimiter(): {
	limiter: DynamoRateLimiter;
	fake: FakeDynamoDocumentClient;
} {
	const fake = new FakeDynamoDocumentClient();
	const limiter = new DynamoRateLimiter(
		fake as unknown as DynamoDBDocumentClient,
		'test-rate-limits',
	);
	return { limiter, fake };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('increment', () => {
	it('succeeds under the limit and reports remaining count', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 5, period: 60 };

		const first = await limiter.increment('user:1', config);
		expect(first).toEqual({ success: true, remainingLimit: 4 });

		const second = await limiter.increment('user:1', config);
		expect(second).toEqual({ success: true, remainingLimit: 3 });
	});

	it('fails once the main limit is reached, without incrementing further', async () => {
		const { limiter, fake } = makeLimiter();
		const config: RateLimitConfig = { limit: 2, period: 60 };

		await limiter.increment('user:1', config);
		await limiter.increment('user:1', config);
		const third = await limiter.increment('user:1', config);

		expect(third).toEqual({
			success: false,
			remainingLimit: 0,
			exceededLimit: 'main',
			limitValue: 2,
			periodSeconds: 60,
		});
		// The blocked third call must not have written a new bucket --
		// all 3 calls landed in the same 10s bucket, so exactly one item
		// should exist, holding count 2 (not 3).
		expect(fake.size).toBe(1);
		const bucketStart = Math.floor(Date.now() / 10_000) * 10_000;
		expect(fake.itemFor('user:1', bucketStart)?.count).toBe(2);
	});

	it('respects a burst sub-window independently of the main window', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = {
			limit: 100,
			period: 3600,
			burst: 2,
			burstWindow: 10,
		};

		await limiter.increment('user:1', config);
		await limiter.increment('user:1', config);
		const third = await limiter.increment('user:1', config);

		expect(third.success).toBe(false);
		expect(third.exceededLimit).toBe('burst');
		expect(third.limitValue).toBe(2);
	});

	it('respects a rolling daily limit independently of the main window', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = {
			limit: 1000,
			period: 60,
			dailyLimit: 2,
		};

		await limiter.increment('user:1', config);
		await limiter.increment('user:1', config);
		const third = await limiter.increment('user:1', config);

		expect(third.success).toBe(false);
		expect(third.exceededLimit).toBe('daily');
	});

	it('checks limits in main -> burst -> daily precedence', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = {
			limit: 1,
			period: 60,
			burst: 1,
			burstWindow: 10,
			dailyLimit: 1,
		};

		await limiter.increment('user:1', config);
		const second = await limiter.increment('user:1', config);

		// All three are exhausted simultaneously here; main is checked first.
		expect(second.exceededLimit).toBe('main');
	});

	it('lets requests through again once the main window rolls past old buckets', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 1, period: 60, bucketSize: 10 };

		await limiter.increment('user:1', config);
		const blocked = await limiter.increment('user:1', config);
		expect(blocked.success).toBe(false);

		vi.setSystemTime(new Date(Date.now() + 61_000));

		const allowedAgain = await limiter.increment('user:1', config);
		expect(allowedAgain.success).toBe(true);
	});

	it('aligns the main window to the UTC calendar day when calendarDaily is set', async () => {
		const { limiter } = makeLimiter();
		// 2026-01-15T12:00:00Z -- well within the day, well short of a 24h
		// rolling period, but calendarDaily should still start counting
		// fresh at each UTC midnight rather than 24h after the first call.
		const config: RateLimitConfig = {
			limit: 1,
			period: 24 * 60 * 60,
			calendarDaily: true,
		};

		await limiter.increment('user:1', config);
		const blocked = await limiter.increment('user:1', config);
		expect(blocked.success).toBe(false);

		// Jump to just after UTC midnight -- a new calendar day, well
		// under 24 rolling hours since the first call.
		vi.setSystemTime(new Date('2026-01-16T00:00:01.000Z'));

		const allowedAgain = await limiter.increment('user:1', config);
		expect(allowedAgain.success).toBe(true);
	});

	it('keeps separate keys fully independent', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 1, period: 60 };

		await limiter.increment('user:1', config);
		const other = await limiter.increment('user:2', config);

		expect(other.success).toBe(true);
	});
});

describe('getRemainingLimit', () => {
	it('does not itself count as a request', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 5, period: 60 };

		await limiter.increment('user:1', config);
		await limiter.getRemainingLimit('user:1', config);
		await limiter.getRemainingLimit('user:1', config);
		const remaining = await limiter.getRemainingLimit('user:1', config);

		expect(remaining).toBe(4);
	});

	it('accounts for the daily limit when present', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 100, period: 60, dailyLimit: 3 };

		await limiter.increment('user:1', config);
		await limiter.increment('user:1', config);

		expect(await limiter.getRemainingLimit('user:1', config)).toBe(1);
	});
});

describe('resetLimit', () => {
	it('clears all buckets for a key, allowing fresh requests immediately', async () => {
		const { limiter } = makeLimiter();
		const config: RateLimitConfig = { limit: 1, period: 60 };

		await limiter.increment('user:1', config);
		expect((await limiter.increment('user:1', config)).success).toBe(false);

		await limiter.resetLimit('user:1');

		expect((await limiter.increment('user:1', config)).success).toBe(true);
	});
});
