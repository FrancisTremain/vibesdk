import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { UsageStore } from './usage-store';

function makeStore() {
	const fake = new FakeDynamoDocumentClient();
	const store = new UsageStore(fake as unknown as DynamoDBDocumentClient, 'usage-table');
	return { fake, store };
}

describe('UsageStore', () => {
	it('aggregates recorded usage for a user', async () => {
		const { store } = makeStore();
		await store.recordUsage({
			userId: 'u1',
			sessionId: 's1',
			provider: 'anthropic',
			model: 'anthropic/claude-sonnet-4-5',
			tokensIn: 1000,
			tokensOut: 500,
			error: false,
		});
		await store.recordUsage({
			userId: 'u1',
			sessionId: 's2',
			provider: 'anthropic',
			model: 'anthropic/claude-sonnet-4-5',
			tokensIn: 2000,
			tokensOut: 1000,
			error: true,
		});

		const result = await store.getUserAnalytics('u1', 7);
		expect(result.userId).toBe('u1');
		expect(result.totalRequests).toBe(2);
		expect(result.tokensIn).toBe(3000);
		expect(result.tokensOut).toBe(1500);
		expect(result.erroredRequests).toBe(1);
		expect(result.errorRate).toBe(0.5);
		expect(result.totalCost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000 + (2000 * 3 + 1000 * 15) / 1_000_000);
		expect(result.lastRequestAt).not.toBeNull();
	});

	it('scopes to a single user, not others', async () => {
		const { store } = makeStore();
		await store.recordUsage({ userId: 'u1', sessionId: 's1', provider: 'anthropic', model: 'x', tokensIn: 10, tokensOut: 10, error: false });
		await store.recordUsage({ userId: 'u2', sessionId: 's2', provider: 'anthropic', model: 'x', tokensIn: 10, tokensOut: 10, error: false });

		const result = await store.getUserAnalytics('u1', 7);
		expect(result.totalRequests).toBe(1);
	});

	it('aggregates recorded usage for a session via the gsi1 index', async () => {
		const { store } = makeStore();
		await store.recordUsage({ userId: 'u1', sessionId: 's1', provider: 'anthropic', model: 'x', tokensIn: 100, tokensOut: 50, error: false });
		await store.recordUsage({ userId: 'u1', sessionId: 's1', provider: 'anthropic', model: 'x', tokensIn: 200, tokensOut: 100, error: false });
		await store.recordUsage({ userId: 'u1', sessionId: 's2', provider: 'anthropic', model: 'x', tokensIn: 999, tokensOut: 999, error: false });

		const result = await store.getSessionAnalytics('s1', 7);
		expect(result.sessionId).toBe('s1');
		expect(result.totalRequests).toBe(2);
		expect(result.tokensIn).toBe(300);
	});

	it('contributes 0 cost for an unpriced model rather than a guessed number', async () => {
		const { store } = makeStore();
		await store.recordUsage({ userId: 'u1', sessionId: 's1', provider: 'mystery', model: 'mystery/unknown-model', tokensIn: 1000, tokensOut: 1000, error: false });

		const result = await store.getUserAnalytics('u1', 7);
		expect(result.totalCost).toBe(0);
	});

	it('returns zeroed analytics with no requests recorded', async () => {
		const { store } = makeStore();
		const result = await store.getUserAnalytics('nobody', 30);
		expect(result.totalRequests).toBe(0);
		expect(result.errorRate).toBe(0);
		expect(result.lastRequestAt).toBeNull();
		expect(result.timeRange.days).toBe(30);
	});
});
