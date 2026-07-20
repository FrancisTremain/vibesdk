/**
 * DynamoDB port of the core of `AppService` — the apps slice of D1
 * (worker/database/services/AppService.ts, 1180 lines) — against a
 * `vibesdk-apps` table, refining Table 2 of
 * docs/aws-dynamodb-schema.md.
 *
 * This is a deliberately scoped subset, not a full port of all ~30
 * methods. What's here is faithful; what's excluded is named, not
 * silently dropped:
 *
 * PORTED: createApp, updateApp (+ its three setter wrappers),
 * checkAppOwnership, getSingleAppWithFavoriteStatus, updateAppVisibility,
 * getAppOwnershipByDeploymentId, getPreviewVersion, getAppDetails,
 * toggleAppFavorite, toggleAppStar, recordAppView, getUserAppsWithFavorites,
 * getRecentAppsWithFavorites, getPublicApps (simplified, see below),
 * deleteApp (simplified, see below).
 *
 * NOT PORTED:
 *   - The weighted trending/popular ranking algorithm
 *     (`executeRankedQuery`, `RANKING_WEIGHTS`, time-period-windowed
 *     recentViews/recentStars). `getPublicApps` here only supports
 *     recent/oldest sort. Real ranking needs its own DynamoDB design
 *     (likely a maintained score attribute + GSI) -- out of scope for
 *     this pass.
 *   - `getUserAppsWithAnalytics`'s 'starred' sort branch and full
 *     ranked-query path, `getUserAppsCount`, `getFavoriteAppsOnly`.
 *   - `deleteApp`'s fork-detachment step (nulling `parentAppId` on any
 *     app that forked from the one being deleted) -- would need a
 *     `by-parent` GSI not designed here. Deleting an app that has forks
 *     leaves their `parentAppId` pointing at a deleted app under this
 *     port; the original detaches them. Real gap, not nothing.
 *   - Screenshot URL signing (`ScreenshotSecurity`) -- a separate,
 *     unrelated concern (CDN URL signing), not a storage question.
 *     `screenshotUrl` is stored and returned as-is.
 *
 * Search (product decision, see docs/aws-migration-product-design.md):
 * degraded to prefix-match on `title` for the MVP, not the original's
 * case-insensitive substring match across title AND description. See
 * the README for exactly what this gives up.
 *
 * Counters improve on the original, same pattern as identity-store.ts:
 * `starCount`/`favoriteCount`/`viewCount` are maintained via atomic
 * `ADD` on the app item itself, rather than computed live via
 * `COUNT(*)`/`COUNT(DISTINCT ...)` queries against the stars/favorites/
 * views tables on every read. Cheaper and simpler at read time; the
 * tradeoff is eventual correctness if a counter update ever fails
 * independently of its paired write (mitigated here by writing the
 * counter update in the same `TransactWriteItems` call as the
 * star/favorite/view record itself).
 */

import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
	DeleteCommand,
	QueryCommand,
	TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
	App,
	AppVisibilityUpdateResult,
	AppWithFavoriteStatus,
	EnhancedAppData,
	FavoriteToggleResult,
	NewApp,
	OwnershipResult,
	PaginatedResult,
	PublicAppQueryOptions,
	Visibility,
	ViewerIdentity,
} from './types';

const SK_META = 'META';
const SK_LOOKUP = 'LOOKUP';
const appPk = (id: string) => `APP#${id}`;
const userPk = (userId: string) => `USER#${userId}`;
const favSk = (userId: string) => `FAV#${userId}`;
const favAppSk = (appId: string) => `FAVAPP#${appId}`;
const starSk = (userId: string) => `STAR#${userId}`;
const starAppSk = (appId: string) => `STARAPP#${appId}`;
const viewSk = (viewerHash: string) => `VIEW#${viewerHash}`;
const deploymentLookupPk = (deploymentId: string) => `DEPLOYMENTID#${deploymentId}`;

/** Constant GSI2 partition for the public listing -- a bounded, browsable
 *  index is exactly the idiomatic DynamoDB case for a single hot
 *  partition. Acceptable at MVP scale; revisit (e.g. shard by a coarse
 *  time bucket) if listing traffic grows enough for it to matter. */
const LISTING_PARTITION = 'LISTING';
const VIEW_DEDUP_BUCKET_MS = 10 * 60 * 1000;

function newId(): string {
	return crypto.randomUUID();
}

function qualifiesForPublicListing(app: Pick<App, 'visibility' | 'userId' | 'status'>): boolean {
	const visibilityOk = app.visibility === 'public' || app.userId === null;
	const statusOk = app.status === 'completed' || app.status === 'generating';
	return visibilityOk && statusOk;
}

interface StoredApp extends App {
	pk: string;
	sk: typeof SK_META;
	gsi1pk?: string;
	gsi1sk?: number;
	gsi2pk?: string;
	gsi2sk?: number;
}

export class AppStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	// ========================================
	// APP OPERATIONS
	// ========================================

	async createApp(appData: NewApp): Promise<App> {
		const id = newId();
		const now = Date.now();
		const app: App = {
			...appData,
			id,
			createdAt: appData.createdAt ?? now,
			updatedAt: appData.updatedAt ?? now,
			starCount: 0,
			favoriteCount: 0,
			viewCount: 0,
		};

		await this.putApp(app);
		return app;
	}

	async updateApp(appId: string, updates: Partial<App>): Promise<boolean> {
		if (!appId) return false;
		try {
			const existing = await this.getAppRaw(appId);
			if (!existing) return false;
			const merged: App = { ...stripStorage(existing), ...updates, updatedAt: Date.now() };
			await this.putApp(merged);
			return true;
		} catch {
			return false;
		}
	}

	async updateDeploymentId(appId: string, deploymentId: string): Promise<boolean> {
		const ok = await this.updateApp(appId, { deploymentId });
		if (ok) {
			await this.ddb.send(
				new PutCommand({
					TableName: this.tableName,
					Item: { pk: deploymentLookupPk(deploymentId), sk: SK_LOOKUP, appId },
				}),
			);
		}
		return ok;
	}

	async updateGitHubRepository(
		appId: string,
		repositoryUrl: string,
		repositoryVisibility: 'public' | 'private',
	): Promise<boolean> {
		return this.updateApp(appId, {
			githubRepositoryUrl: repositoryUrl,
			githubRepositoryVisibility: repositoryVisibility,
		});
	}

	async updateAppScreenshot(appId: string, screenshotUrl: string): Promise<boolean> {
		return this.updateApp(appId, { screenshotUrl, screenshotCapturedAt: Date.now() });
	}

	async checkAppOwnership(appId: string, userId: string): Promise<OwnershipResult> {
		const app = await this.getAppRaw(appId);
		if (!app) return { exists: false, isOwner: false };
		return { exists: true, isOwner: app.userId === userId, visibility: app.visibility };
	}

	async getSingleAppWithFavoriteStatus(
		appId: string,
		userId: string,
	): Promise<AppWithFavoriteStatus | null> {
		const app = await this.getAppRaw(appId);
		if (!app) return null;
		const isFavorite = await this.hasFavorited(userId, appId);
		return { ...stripStorage(app), isFavorite };
	}

	async updateAppVisibility(
		appId: string,
		userId: string,
		visibility: Visibility,
	): Promise<AppVisibilityUpdateResult> {
		const app = await this.getAppRaw(appId);
		if (!app) return { success: false, error: 'App not found' };
		if (app.userId !== userId) {
			return { success: false, error: 'You can only change visibility of your own apps' };
		}

		const updated: App = {
			...stripStorage(app),
			visibility,
			previewVersion: app.previewVersion + 1,
			updatedAt: Date.now(),
		};
		await this.putApp(updated);

		return {
			success: true,
			app: { id: updated.id, title: updated.title, visibility: updated.visibility, updatedAt: updated.updatedAt },
		};
	}

	async getAppOwnershipByDeploymentId(
		deploymentId: string,
	): Promise<{ id: string; userId: string | null; visibility: Visibility } | null> {
		const lookup = await this.ddb.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: deploymentLookupPk(deploymentId), sk: SK_LOOKUP },
			}),
		);
		const appId = (lookup.Item as { appId?: string } | undefined)?.appId;
		if (!appId) return null;

		const app = await this.getAppRaw(appId);
		if (!app) return null;
		return { id: app.id, userId: app.userId, visibility: app.visibility };
	}

	async getPreviewVersion(appId: string): Promise<number | null> {
		const app = await this.getAppRaw(appId);
		return app ? app.previewVersion : null;
	}

	async getAppDetails(appId: string, userId?: string): Promise<EnhancedAppData | null> {
		const app = await this.getAppRaw(appId);
		if (!app) return null;

		const [userFavorited, userStarred] = await Promise.all([
			userId ? this.hasFavorited(userId, appId) : Promise.resolve(false),
			userId ? this.hasStarred(userId, appId) : Promise.resolve(false),
		]);

		return { ...stripStorage(app), userFavorited, userStarred };
	}

	// ========================================
	// FAVORITES / STARS / VIEWS
	// ========================================

	async toggleAppFavorite(userId: string, appId: string): Promise<FavoriteToggleResult> {
		const already = await this.hasFavorited(userId, appId);

		if (already) {
			await this.ddb.send(
				new TransactWriteCommand({
					TransactItems: [
						{ Delete: { TableName: this.tableName, Key: { pk: appPk(appId), sk: favSk(userId) } } },
						{ Delete: { TableName: this.tableName, Key: { pk: userPk(userId), sk: favAppSk(appId) } } },
						{
							Update: {
								TableName: this.tableName,
								Key: { pk: appPk(appId), sk: SK_META },
								UpdateExpression: 'ADD favoriteCount :neg',
								ExpressionAttributeValues: { ':neg': -1 },
							},
						},
					],
				}),
			);
			return { isFavorite: false };
		}

		const now = Date.now();
		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: this.tableName,
							Item: { pk: appPk(appId), sk: favSk(userId), userId, appId, createdAt: now },
						},
					},
					{
						Put: {
							TableName: this.tableName,
							Item: { pk: userPk(userId), sk: favAppSk(appId), userId, appId, createdAt: now },
						},
					},
					{
						Update: {
							TableName: this.tableName,
							Key: { pk: appPk(appId), sk: SK_META },
							UpdateExpression: 'ADD favoriteCount :one',
							ExpressionAttributeValues: { ':one': 1 },
						},
					},
				],
			}),
		);
		return { isFavorite: true };
	}

	async toggleAppStar(userId: string, appId: string): Promise<{ isStarred: boolean; starCount: number }> {
		const already = await this.hasStarred(userId, appId);

		await this.ddb.send(
			new TransactWriteCommand({
				TransactItems: already
					? [
							{ Delete: { TableName: this.tableName, Key: { pk: appPk(appId), sk: starSk(userId) } } },
							{ Delete: { TableName: this.tableName, Key: { pk: userPk(userId), sk: starAppSk(appId) } } },
							{
								Update: {
									TableName: this.tableName,
									Key: { pk: appPk(appId), sk: SK_META },
									UpdateExpression: 'ADD starCount :neg',
									ExpressionAttributeValues: { ':neg': -1 },
								},
							},
						]
					: [
							{
								Put: {
									TableName: this.tableName,
									Item: {
										pk: appPk(appId),
										sk: starSk(userId),
										userId,
										appId,
										starredAt: Date.now(),
									},
								},
							},
							{
								Put: {
									TableName: this.tableName,
									Item: {
										pk: userPk(userId),
										sk: starAppSk(appId),
										userId,
										appId,
										starredAt: Date.now(),
									},
								},
							},
							{
								Update: {
									TableName: this.tableName,
									Key: { pk: appPk(appId), sk: SK_META },
									UpdateExpression: 'ADD starCount :one',
									ExpressionAttributeValues: { ':one': 1 },
								},
							},
						],
			}),
		);

		const app = await this.getAppRaw(appId);
		return { isStarred: !already, starCount: app?.starCount ?? 0 };
	}

	async recordAppView(appId: string, viewer: ViewerIdentity): Promise<void> {
		const { viewerHash, bucketEndMs } = await computeViewerHash(appId, viewer);
		try {
			await this.ddb.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: {
									pk: appPk(appId),
									sk: viewSk(viewerHash),
									appId,
									userId: viewer.userId ?? null,
									viewedAt: Date.now(),
									ttl: Math.floor(bucketEndMs / 1000),
								},
								ConditionExpression: 'attribute_not_exists(pk)',
							},
						},
						{
							Update: {
								TableName: this.tableName,
								Key: { pk: appPk(appId), sk: SK_META },
								UpdateExpression: 'ADD viewCount :one',
								ExpressionAttributeValues: { ':one': 1 },
							},
						},
					],
				}),
			);
		} catch {
			// Same view within the same dedup bucket -- ignored, matching
			// the original's onConflictDoNothing behavior.
		}
	}

	// ========================================
	// LISTINGS
	// ========================================

	async getUserAppsWithFavorites(
		userId: string,
		options: { limit?: number; offset?: number } = {},
	): Promise<AppWithFavoriteStatus[]> {
		const { limit = 50, offset = 0 } = options;
		const apps = await this.queryByGsi('gsi1', userId, limit, offset);
		if (apps.length === 0) return [];

		const favoriteChecks = await Promise.all(apps.map((a) => this.hasFavorited(userId, a.id)));
		return apps.map((app, i) => ({ ...app, isFavorite: favoriteChecks[i]! }));
	}

	async getRecentAppsWithFavorites(userId: string, limit = 10): Promise<AppWithFavoriteStatus[]> {
		return this.getUserAppsWithFavorites(userId, { limit, offset: 0 });
	}

	/**
	 * Simplified from the original: recent/oldest sort only (no
	 * popular/trending ranking, see module comment); search is
	 * prefix-match on title only (product decision, see module comment).
	 */
	async getPublicApps(options: PublicAppQueryOptions = {}): Promise<PaginatedResult<EnhancedAppData>> {
		const { limit = 20, offset = 0, sort = 'recent', framework, search, userId } = options;

		const all = await this.queryListingPartition();
		let filtered = all;
		if (framework) filtered = filtered.filter((a) => a.framework === framework);
		if (search) {
			const prefix = search.toLowerCase();
			filtered = filtered.filter((a) => a.title.toLowerCase().startsWith(prefix));
		}
		filtered.sort((a, b) => (sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));

		const total = filtered.length;
		const page = filtered.slice(offset, offset + limit);

		const enhanced: EnhancedAppData[] = await Promise.all(
			page.map(async (app) => ({
				...app,
				userFavorited: userId ? await this.hasFavorited(userId, app.id) : false,
				userStarred: userId ? await this.hasStarred(userId, app.id) : false,
			})),
		);

		return {
			data: enhanced,
			pagination: { limit, offset, total, hasMore: offset + limit < total },
		};
	}

	/** Fork-detachment not ported -- see module comment. */
	async deleteApp(appId: string, userId: string): Promise<{ success: boolean; error?: string }> {
		const ownership = await this.checkAppOwnership(appId, userId);
		if (!ownership.exists) return { success: false, error: 'App not found' };
		if (!ownership.isOwner) return { success: false, error: 'You can only delete your own apps' };

		const [favorites, stars, views] = await Promise.all([
			this.queryAppEdges(appId, 'FAV#'),
			this.queryAppEdges(appId, 'STAR#'),
			this.queryAppEdges(appId, 'VIEW#'),
		]);

		for (const item of [...favorites, ...stars, ...views]) {
			await this.ddb.send(
				new DeleteCommand({ TableName: this.tableName, Key: { pk: appPk(appId), sk: item.sk } }),
			);
		}
		for (const fav of favorites) {
			await this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: userPk(fav.userId as string), sk: favAppSk(appId) },
				}),
			);
		}
		for (const star of stars) {
			await this.ddb.send(
				new DeleteCommand({
					TableName: this.tableName,
					Key: { pk: userPk(star.userId as string), sk: starAppSk(appId) },
				}),
			);
		}

		await this.ddb.send(
			new DeleteCommand({ TableName: this.tableName, Key: { pk: appPk(appId), sk: SK_META } }),
		);
		return { success: true };
	}

	// ========================================
	// INTERNAL
	// ========================================

	private async putApp(app: App): Promise<void> {
		const item: StoredApp = {
			...app,
			pk: appPk(app.id),
			sk: SK_META,
			...(app.userId ? { gsi1pk: app.userId, gsi1sk: app.updatedAt } : {}),
			...(qualifiesForPublicListing(app)
				? { gsi2pk: LISTING_PARTITION, gsi2sk: app.updatedAt }
				: {}),
		};
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
	}

	private async getAppRaw(appId: string): Promise<StoredApp | undefined> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk: appPk(appId), sk: SK_META } }),
		);
		return result.Item as StoredApp | undefined;
	}

	private async hasFavorited(userId: string, appId: string): Promise<boolean> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk: appPk(appId), sk: favSk(userId) } }),
		);
		return !!result.Item;
	}

	private async hasStarred(userId: string, appId: string): Promise<boolean> {
		const result = await this.ddb.send(
			new GetCommand({ TableName: this.tableName, Key: { pk: appPk(appId), sk: starSk(userId) } }),
		);
		return !!result.Item;
	}

	private async queryByGsi(
		index: 'gsi1',
		pkValue: string,
		limit: number,
		offset: number,
	): Promise<App[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				IndexName: index,
				KeyConditionExpression: `${index}pk = :pk`,
				ExpressionAttributeValues: { ':pk': pkValue },
				ScanIndexForward: false,
			}),
		);
		const items = ((result.Items as StoredApp[] | undefined) ?? []).map(stripStorage);
		return items.slice(offset, offset + limit);
	}

	private async queryListingPartition(): Promise<App[]> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				IndexName: 'gsi2',
				KeyConditionExpression: 'gsi2pk = :pk',
				ExpressionAttributeValues: { ':pk': LISTING_PARTITION },
			}),
		);
		return ((result.Items as StoredApp[] | undefined) ?? []).map(stripStorage);
	}

	private async queryAppEdges(
		appId: string,
		prefix: string,
	): Promise<Array<{ sk: string; userId?: unknown }>> {
		const result = await this.ddb.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
				ExpressionAttributeValues: { ':pk': appPk(appId), ':prefix': prefix },
			}),
		);
		return (result.Items as Array<{ sk: string; userId?: unknown }> | undefined) ?? [];
	}
}

function stripStorage(item: StoredApp): App {
	const { pk: _pk, sk: _sk, gsi1pk: _g1p, gsi1sk: _g1s, gsi2pk: _g2p, gsi2sk: _g2s, ...rest } = item;
	return rest;
}

/** Ported as-is from AppService.computeViewerHash. */
async function computeViewerHash(
	appId: string,
	viewer: ViewerIdentity,
): Promise<{ viewerHash: string; bucketEndMs: number }> {
	const bucket = Math.floor(Date.now() / VIEW_DEDUP_BUCKET_MS);
	const seed = viewer.userId
		? `u:${viewer.userId}`
		: `a:${viewer.ipAddress ?? 'unknown'}:${viewer.userAgent ?? 'unknown'}:${appId}`;
	const data = new TextEncoder().encode(`${seed}:${bucket}`);
	const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
	const viewerHash = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return { viewerHash, bucketEndMs: (bucket + 1) * VIEW_DEDUP_BUCKET_MS };
}
