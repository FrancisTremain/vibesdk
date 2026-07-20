/**
 * DynamoDB port of the feasible part of `AnalyticsService`
 * (worker/database/services/AnalyticsService.ts, 255 lines).
 *
 * Reads directly from the same `vibesdk-apps` table `aws/db-apps`
 * writes to, using the same key scheme (`APP#<id>`/`META`, `gsi1`
 * keyed by `userId`, and the `USER#<userId>`/`FAVAPP#<appId>` reverse
 * favorite-lookup items). This is a real coupling between the two
 * packages' schemas, not hidden: this package doesn't depend on
 * `aws/db-apps` as a library, but it does depend on its table shape
 * staying what it is. If that table's key scheme changes, this package
 * needs to change with it.
 *
 * What makes most of this port *cheap* rather than another
 * `AppService`-style aggregation wall: `db-apps` already maintains
 * `favoriteCount`/`viewCount` on each app item (an atomic `ADD` on
 * every favorite/star/view, not a live `COUNT(*)`). `getUserStats`'s
 * "total likes/views received across a user's apps" becomes summing
 * two already-maintained numbers across a `Query` result, not a join.
 *
 * NOT PORTED: `batchGetAppStats`. It needs `forkCount` (would require
 * a `by-parent` GSI — explicitly not built in `aws/db-apps`, a named
 * gap there) and `likeCount` from the `app_likes` table (not modeled
 * at all — `aws/db-apps` only carries favorites/stars). Both are
 * already-flagged gaps upstream; this package doesn't paper over them
 * with a fake number.
 */

import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSummary, UserActivity, UserStats } from './types';

const userPk = (userId: string) => `USER#${userId}`;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayBucket(epochMs: number): number {
	return Math.floor(epochMs / MS_PER_DAY);
}

export class AnalyticsStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly appsTableName: string,
	) {}

	async getUserStats(userId: string): Promise<UserStats> {
		const [apps, favoritedByUserCount] = await Promise.all([
			this.getUserApps(userId),
			this.countFavoritesByUser(userId),
		]);

		const appCount = apps.length;
		const publicAppCount = apps.filter((a) => a.visibility === 'public').length;
		const totalLikesReceived = apps.reduce((sum, a) => sum + a.favoriteCount, 0);
		const totalViewsReceived = apps.reduce((sum, a) => sum + a.viewCount, 0);
		const streakDays = computeStreak(apps.map((a) => a.updatedAt));

		return {
			appCount,
			publicAppCount,
			favoriteCount: favoritedByUserCount,
			totalLikesReceived,
			totalViewsReceived,
			streakDays,
			achievements: [], // Placeholder, matches the original.
		};
	}

	async getUserActivityTimeline(userId: string, limit = 20): Promise<UserActivity[]> {
		const apps = await this.getUserApps(userId);
		const appActivities: UserActivity[] = apps
			.slice() // getUserApps is already sorted by updatedAt desc
			.slice(0, limit)
			.map((a) => ({
				type: a.createdAt === a.updatedAt ? 'created' : 'updated',
				title: a.title,
				timestamp: a.updatedAt,
				metadata: { appId: a.id },
			}));

		const favorites = await this.getUserFavoritedApps(userId, Math.floor(limit / 2));
		const favoriteActivities: UserActivity[] = favorites.map((f) => ({
			type: 'favorited',
			title: f.appTitle,
			timestamp: f.timestamp,
			metadata: { appId: f.appId },
		}));

		return [...appActivities, ...favoriteActivities]
			.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
			.slice(0, limit);
	}

	// ========================================
	// INTERNAL
	// ========================================

	private async getUserApps(userId: string): Promise<AppSummary[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.appsTableName,
				IndexName: 'gsi1',
				KeyConditionExpression: 'gsi1pk = :pk',
				ExpressionAttributeValues: { ':pk': userId },
				ScanIndexForward: false,
			}),
		);
		return (result.Items as AppSummary[] | undefined) ?? [];
	}

	private async countFavoritesByUser(userId: string): Promise<number> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.appsTableName,
				KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
				ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'FAVAPP#' },
			}),
		);
		return (result.Items ?? []).length;
	}

	private async getUserFavoritedApps(
		userId: string,
		limit: number,
	): Promise<Array<{ appId: string; appTitle: string; timestamp: number }>> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.appsTableName,
				KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
				ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': 'FAVAPP#' },
				ScanIndexForward: false,
			}),
		);
		const favorites = (result.Items as Array<{ appId: string; createdAt: number }> | undefined) ?? [];

		const withTitles = await Promise.all(
			favorites.slice(0, limit).map(async (f) => {
				const app = await this.ddb.send(
					new GetCommand({
						TableName: this.appsTableName,
						Key: { pk: `APP#${f.appId}`, sk: 'META' },
					}),
				);
				const title = (app.Item as { title?: string } | undefined)?.title ?? 'Unknown App';
				return { appId: f.appId, appTitle: title, timestamp: f.createdAt };
			}),
		);
		return withTitles;
	}
}

/**
 * Ported from AppService.calculateUserStreak: consecutive UTC days with
 * activity, counting back from the most recent, broken by any gap of
 * more than one day. Reimplemented over an in-memory timestamp list
 * (from a GSI Query already sorted by recency) instead of a SQL
 * `GROUP BY DATE(...)` -- same logic, different data source.
 */
function computeStreak(updatedAtTimestamps: number[]): number {
	if (updatedAtTimestamps.length === 0) return 0;

	const uniqueDaysDesc = Array.from(new Set(updatedAtTimestamps.map(dayBucket))).sort((a, b) => b - a);

	const today = dayBucket(Date.now());
	if (today - uniqueDaysDesc[0]! > 1) return 0; // Streak broken -- no recent activity.

	let streak = 1;
	let currentDay = uniqueDaysDesc[0]!;
	for (let i = 1; i < uniqueDaysDesc.length; i++) {
		const day = uniqueDaysDesc[i]!;
		if (currentDay - day <= 1) {
			streak++;
			currentDay = day;
		} else {
			break;
		}
	}
	return streak;
}
