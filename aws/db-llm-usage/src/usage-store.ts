/**
 * AWS-native replacement for AiGatewayAnalyticsService
 * (worker/services/analytics/AiGatewayAnalyticsService.ts), which
 * queries Cloudflare AI Gateway's GraphQL Analytics API -- there is no
 * AWS equivalent to that service, so this package tracks usage itself:
 * one item per aws/llm-client `runInference` call, written by
 * aws/agent-runtime immediately after each call, queried here to
 * compute the same shape of aggregate the original returned.
 *
 * NOT tracked (the original's AI Gateway query surfaced these, this
 * doesn't): cache hit/miss (aws/llm-client has no caching layer to
 * report on), per-hour activity buckets, and query response time.
 * Reporting fabricated values for those would be worse than omitting
 * them -- see this package's README.
 */

import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { estimateCost } from './pricing';
import type { RecordUsageParams, SessionUsageAnalytics, UsageAnalytics, UserUsageAnalytics } from './types';

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days -- usage detail beyond that isn't worth the storage cost.
const userPk = (userId: string) => `user#${userId}`;
const sessionGsiPk = (sessionId: string) => `session#${sessionId}`;

interface UsageItem {
	pk: string;
	sk: string;
	gsi1pk: string;
	gsi1sk: string;
	userId: string;
	sessionId: string;
	provider: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	cost: number;
	error: boolean;
	createdAt: string;
	ttl: number;
}

export class UsageStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async recordUsage(params: RecordUsageParams): Promise<void> {
		const now = new Date();
		const sk = `${now.toISOString()}#${randomUUID()}`;
		const item: UsageItem = {
			pk: userPk(params.userId),
			sk,
			gsi1pk: sessionGsiPk(params.sessionId),
			gsi1sk: sk,
			userId: params.userId,
			sessionId: params.sessionId,
			provider: params.provider,
			model: params.model,
			tokensIn: params.tokensIn,
			tokensOut: params.tokensOut,
			cost: estimateCost(params.model, params.tokensIn, params.tokensOut),
			error: params.error,
			createdAt: now.toISOString(),
			ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
		};
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
	}

	async getUserAnalytics(userId: string, days: number): Promise<UserUsageAnalytics> {
		const { start, end } = timeRange(days);
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: 'pk = :pk AND sk >= :cutoff',
				ExpressionAttributeValues: { ':pk': userPk(userId), ':cutoff': start.toISOString() },
			}),
		);
		return { userId, ...aggregate((result.Items as UsageItem[] | undefined) ?? [], start, end, days) };
	}

	async getSessionAnalytics(sessionId: string, days: number): Promise<SessionUsageAnalytics> {
		const { start, end } = timeRange(days);
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				IndexName: 'gsi1',
				KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk >= :cutoff',
				ExpressionAttributeValues: { ':pk': sessionGsiPk(sessionId), ':cutoff': start.toISOString() },
			}),
		);
		return { sessionId, ...aggregate((result.Items as UsageItem[] | undefined) ?? [], start, end, days) };
	}
}

function timeRange(days: number): { start: Date; end: Date } {
	const end = new Date();
	const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
	return { start, end };
}

function aggregate(items: UsageItem[], start: Date, end: Date, days: number): UsageAnalytics {
	let totalCost = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let erroredRequests = 0;
	let lastRequestAt: string | null = null;

	for (const item of items) {
		totalCost += item.cost;
		tokensIn += item.tokensIn;
		tokensOut += item.tokensOut;
		if (item.error) erroredRequests++;
		if (!lastRequestAt || item.createdAt > lastRequestAt) lastRequestAt = item.createdAt;
	}

	return {
		totalRequests: items.length,
		totalCost,
		tokensIn,
		tokensOut,
		erroredRequests,
		errorRate: items.length > 0 ? erroredRequests / items.length : 0,
		lastRequestAt,
		timeRange: { start: start.toISOString(), end: end.toISOString(), days },
	};
}
