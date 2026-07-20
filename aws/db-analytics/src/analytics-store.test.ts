import { describe, expect, it } from 'vitest';
import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { AnalyticsStore } from './analytics-store';

const TABLE = 'test-apps';
const DAY = 24 * 60 * 60 * 1000;

function makeStore(): { store: AnalyticsStore; fake: FakeDynamoDocumentClient } {
	const fake = new FakeDynamoDocumentClient();
	const store = new AnalyticsStore(fake as unknown as DynamoDBDocumentClient, TABLE);
	return { store, fake };
}

/** Seeds an app item the way aws/db-apps's AppStore would write it. */
async function seedApp(
	fake: FakeDynamoDocumentClient,
	app: {
		id: string;
		title: string;
		userId: string;
		visibility: 'private' | 'public';
		createdAt: number;
		updatedAt: number;
		favoriteCount?: number;
		viewCount?: number;
	},
): Promise<void> {
	await fake.send(
		new PutCommand({
			TableName: TABLE,
			Item: {
				pk: `APP#${app.id}`,
				sk: 'META',
				id: app.id,
				title: app.title,
				userId: app.userId,
				visibility: app.visibility,
				createdAt: app.createdAt,
				updatedAt: app.updatedAt,
				favoriteCount: app.favoriteCount ?? 0,
				viewCount: app.viewCount ?? 0,
				gsi1pk: app.userId,
				gsi1sk: app.updatedAt,
			},
		}),
	);
}

async function seedFavorite(
	fake: FakeDynamoDocumentClient,
	userId: string,
	appId: string,
	createdAt: number,
): Promise<void> {
	await fake.send(
		new PutCommand({
			TableName: TABLE,
			Item: { pk: `USER#${userId}`, sk: `FAVAPP#${appId}`, userId, appId, createdAt },
		}),
	);
}

describe('getUserStats', () => {
	it('counts apps, public apps, and sums maintained counters across them', async () => {
		const { store, fake } = makeStore();
		const now = Date.now();
		await seedApp(fake, {
			id: 'a1', title: 'App 1', userId: 'alice', visibility: 'public',
			createdAt: now, updatedAt: now, favoriteCount: 3, viewCount: 10,
		});
		await seedApp(fake, {
			id: 'a2', title: 'App 2', userId: 'alice', visibility: 'private',
			createdAt: now, updatedAt: now, favoriteCount: 1, viewCount: 5,
		});

		const stats = await store.getUserStats('alice');
		expect(stats.appCount).toBe(2);
		expect(stats.publicAppCount).toBe(1);
		expect(stats.totalLikesReceived).toBe(4);
		expect(stats.totalViewsReceived).toBe(15);
		expect(stats.achievements).toEqual([]);
	});

	it('counts how many apps the user has favorited, not how many favorites their apps received', async () => {
		const { store, fake } = makeStore();
		const now = Date.now();
		await seedApp(fake, {
			id: 'a1', title: 'App 1', userId: 'bob', visibility: 'public',
			createdAt: now, updatedAt: now,
		});
		await seedFavorite(fake, 'alice', 'someone-elses-app-1', now);
		await seedFavorite(fake, 'alice', 'someone-elses-app-2', now);

		const stats = await store.getUserStats('alice');
		expect(stats.favoriteCount).toBe(2);
		expect(stats.appCount).toBe(0); // alice owns no apps
	});

	it('returns zeros for a user with no apps', async () => {
		const { store } = makeStore();
		const stats = await store.getUserStats('nobody');
		expect(stats).toMatchObject({
			appCount: 0,
			publicAppCount: 0,
			favoriteCount: 0,
			totalLikesReceived: 0,
			totalViewsReceived: 0,
			streakDays: 0,
		});
	});
});

describe('streak calculation', () => {
	it('counts consecutive days of activity ending today', async () => {
		const { store, fake } = makeStore();
		const today = Date.now();
		await seedApp(fake, { id: 'a1', title: 'A', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today });
		await seedApp(fake, { id: 'a2', title: 'B', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today - DAY });
		await seedApp(fake, { id: 'a3', title: 'C', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today - 2 * DAY });

		const stats = await store.getUserStats('alice');
		expect(stats.streakDays).toBe(3);
	});

	it('breaks the streak on a gap of more than one day', async () => {
		const { store, fake } = makeStore();
		const today = Date.now();
		await seedApp(fake, { id: 'a1', title: 'A', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today });
		await seedApp(fake, { id: 'a2', title: 'B', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today - 5 * DAY });

		const stats = await store.getUserStats('alice');
		expect(stats.streakDays).toBe(1);
	});

	it('is zero if the most recent activity is more than a day old', async () => {
		const { store, fake } = makeStore();
		const staleTime = Date.now() - 5 * DAY;
		await seedApp(fake, { id: 'a1', title: 'A', userId: 'alice', visibility: 'private', createdAt: staleTime, updatedAt: staleTime });

		const stats = await store.getUserStats('alice');
		expect(stats.streakDays).toBe(0);
	});

	it('counts multiple apps updated the same day as one day of activity, not one per app', async () => {
		const { store, fake } = makeStore();
		const today = Date.now();
		await seedApp(fake, { id: 'a1', title: 'A', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today });
		await seedApp(fake, { id: 'a2', title: 'B', userId: 'alice', visibility: 'private', createdAt: today, updatedAt: today });

		const stats = await store.getUserStats('alice');
		expect(stats.streakDays).toBe(1);
	});
});

describe('getUserActivityTimeline', () => {
	it('combines app and favorite activity, sorted by recency', async () => {
		const { store, fake } = makeStore();
		const now = Date.now();
		await seedApp(fake, {
			id: 'a1', title: 'Newest App', userId: 'alice', visibility: 'private',
			createdAt: now - DAY, updatedAt: now,
		});
		await seedApp(fake, {
			id: 'a2', title: 'Older App', userId: 'alice', visibility: 'private',
			createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY,
		});
		await seedApp(fake, { id: 'fav-target', title: 'Favorited App', userId: 'bob', visibility: 'public', createdAt: now, updatedAt: now });
		await seedFavorite(fake, 'alice', 'fav-target', now - DAY / 2);

		const timeline = await store.getUserActivityTimeline('alice', 10);

		expect(timeline.map((a) => a.title)).toEqual([
			'Newest App', // updated now
			'Favorited App', // favorited half a day ago
			'Older App', // created/updated 2 days ago, same timestamp -> 'created'
		]);
		expect(timeline[0]).toMatchObject({ type: 'updated' });
		expect(timeline[1]).toMatchObject({ type: 'favorited' });
		expect(timeline[2]).toMatchObject({ type: 'created' });
	});

	it('respects the limit', async () => {
		const { store, fake } = makeStore();
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			await seedApp(fake, {
				id: `a${i}`, title: `App ${i}`, userId: 'alice', visibility: 'private',
				createdAt: now - i * DAY, updatedAt: now - i * DAY,
			});
		}

		const timeline = await store.getUserActivityTimeline('alice', 3);
		expect(timeline).toHaveLength(3);
	});
});
