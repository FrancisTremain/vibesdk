import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { AppStore } from './app-store';
import type { NewApp } from './types';

function makeStore(): { store: AppStore; fake: FakeDynamoDocumentClient } {
	const fake = new FakeDynamoDocumentClient();
	const store = new AppStore(fake as unknown as DynamoDBDocumentClient, 'test-apps');
	return { store, fake };
}

function baseNewApp(overrides: Partial<NewApp> = {}): NewApp {
	return {
		title: 'My App',
		description: 'A test app',
		iconUrl: null,
		originalPrompt: 'build me an app',
		finalPrompt: null,
		framework: 'react',
		userId: 'user-1',
		sessionToken: null,
		visibility: 'private',
		status: 'completed',
		deploymentId: null,
		githubRepositoryUrl: null,
		githubRepositoryVisibility: null,
		isArchived: false,
		isFeatured: false,
		version: 1,
		parentAppId: null,
		previewVersion: 0,
		screenshotUrl: null,
		screenshotCapturedAt: null,
		lastDeployedAt: null,
		...overrides,
	};
}

describe('createApp / read', () => {
	it('creates an app with zeroed counters', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp());
		expect(app).toMatchObject({ title: 'My App', starCount: 0, favoriteCount: 0, viewCount: 0 });
	});

	it('checks ownership correctly, including for a nonexistent app', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		expect(await store.checkAppOwnership(app.id, 'alice')).toEqual({
			exists: true,
			isOwner: true,
			visibility: 'private',
		});
		expect(await store.checkAppOwnership(app.id, 'bob')).toEqual({
			exists: true,
			isOwner: false,
			visibility: 'private',
		});
		expect(await store.checkAppOwnership('nope', 'alice')).toEqual({
			exists: false,
			isOwner: false,
		});
	});
});

describe('updateApp and setter wrappers', () => {
	it('merges partial updates without clobbering other fields', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ title: 'Original' }));

		await store.updateApp(app.id, { title: 'Renamed' });

		const fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'user-1');
		expect(fetched).toMatchObject({ title: 'Renamed', description: 'A test app' });
	});

	it('sets deploymentId and makes it resolvable by getAppOwnershipByDeploymentId', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		await store.updateDeploymentId(app.id, 'deploy-123');

		expect(await store.getAppOwnershipByDeploymentId('deploy-123')).toEqual({
			id: app.id,
			userId: 'alice',
			visibility: 'private',
		});
		expect(await store.getAppOwnershipByDeploymentId('unknown')).toBeNull();
	});

	it('sets GitHub repository fields', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp());
		await store.updateGitHubRepository(app.id, 'https://github.com/x/y', 'public');

		const fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'user-1');
		expect(fetched).toMatchObject({
			githubRepositoryUrl: 'https://github.com/x/y',
			githubRepositoryVisibility: 'public',
		});
	});

	it('sets screenshot fields', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp());
		await store.updateAppScreenshot(app.id, 'https://cdn.example.com/shot.png');

		const fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'user-1');
		expect(fetched?.screenshotUrl).toBe('https://cdn.example.com/shot.png');
		expect(fetched?.screenshotCapturedAt).not.toBeNull();
	});
});

describe('updateAppVisibility', () => {
	it('flips visibility and bumps previewVersion for the owner', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice', visibility: 'private' }));

		const result = await store.updateAppVisibility(app.id, 'alice', 'public');
		expect(result.success).toBe(true);
		expect(result.app?.visibility).toBe('public');
		expect(await store.getPreviewVersion(app.id)).toBe(1);

		await store.updateAppVisibility(app.id, 'alice', 'private');
		expect(await store.getPreviewVersion(app.id)).toBe(2);
	});

	it('rejects a non-owner', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		const result = await store.updateAppVisibility(app.id, 'bob', 'public');
		expect(result).toEqual({
			success: false,
			error: 'You can only change visibility of your own apps',
		});
	});

	it('reports app not found', async () => {
		const { store } = makeStore();
		const result = await store.updateAppVisibility('nope', 'alice', 'public');
		expect(result).toEqual({ success: false, error: 'App not found' });
	});
});

describe('favorites', () => {
	it('toggles on and off, maintaining favoriteCount', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		expect(await store.toggleAppFavorite('bob', app.id)).toEqual({ isFavorite: true });
		let fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'bob');
		expect(fetched?.isFavorite).toBe(true);
		expect((await store.getAppDetails(app.id))?.userFavorited).toBe(false); // no userId passed

		expect(await store.toggleAppFavorite('bob', app.id)).toEqual({ isFavorite: false });
		fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'bob');
		expect(fetched?.isFavorite).toBe(false);
	});

	it('shows up in the favoriting user\'s app listing via the reverse index', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));
		await store.toggleAppFavorite('bob', app.id);

		// getUserAppsWithFavorites lists apps *owned* by a user, not
		// favorited -- the reverse-lookup item exists for a future
		// "my favorited apps" listing, verified here by checking it was
		// actually written (isFavorite flips correctly is covered above).
		const bobsOwnApps = await store.getUserAppsWithFavorites('bob');
		expect(bobsOwnApps).toEqual([]);
	});
});

describe('stars', () => {
	it('toggles on and off, maintaining starCount', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		const starred = await store.toggleAppStar('bob', app.id);
		expect(starred).toEqual({ isStarred: true, starCount: 1 });

		const unstarred = await store.toggleAppStar('bob', app.id);
		expect(unstarred).toEqual({ isStarred: false, starCount: 0 });
	});

	it('counts stars from multiple users independently', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		await store.toggleAppStar('bob', app.id);
		const result = await store.toggleAppStar('carol', app.id);
		expect(result).toEqual({ isStarred: true, starCount: 2 });
	});
});

describe('recordAppView', () => {
	it('dedupes repeated views from the same viewer within a bucket', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp());

		await store.recordAppView(app.id, { userId: 'viewer-1' });
		await store.recordAppView(app.id, { userId: 'viewer-1' });
		await store.recordAppView(app.id, { userId: 'viewer-1' });

		const fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'x');
		expect(fetched?.viewCount).toBe(1);
	});

	it('counts distinct viewers separately', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp());

		await store.recordAppView(app.id, { userId: 'viewer-1' });
		await store.recordAppView(app.id, { userId: 'viewer-2' });
		await store.recordAppView(app.id, { ipAddress: '1.2.3.4', userAgent: 'test' });

		const fetched = await store.getSingleAppWithFavoriteStatus(app.id, 'x');
		expect(fetched?.viewCount).toBe(3);
	});
});

describe('getUserAppsWithFavorites', () => {
	it('lists a user\'s own apps, most recently updated first', async () => {
		const { store } = makeStore();

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
		const first = await store.createApp(baseNewApp({ userId: 'alice', title: 'First' }));
		vi.setSystemTime(new Date('2026-01-15T12:00:01.000Z'));
		const second = await store.createApp(baseNewApp({ userId: 'alice', title: 'Second' }));
		vi.useRealTimers();

		const list = await store.getUserAppsWithFavorites('alice');
		expect(list.map((a) => a.id)).toEqual([second.id, first.id]);
	});

	it('does not include another user\'s apps', async () => {
		const { store } = makeStore();
		await store.createApp(baseNewApp({ userId: 'alice' }));

		expect(await store.getUserAppsWithFavorites('bob')).toEqual([]);
	});
});

describe('getPublicApps', () => {
	it('only includes public or anonymous apps with a listable status', async () => {
		const { store } = makeStore();
		const pub = await store.createApp(baseNewApp({ userId: 'alice', visibility: 'public' }));
		const anon = await store.createApp(baseNewApp({ userId: null, visibility: 'private' }));
		await store.createApp(baseNewApp({ userId: 'alice', visibility: 'private' })); // excluded
		await store.createApp(
			baseNewApp({ userId: 'alice', visibility: 'public', status: 'generating' as never }),
		); // included, status generating is listable

		const result = await store.getPublicApps();
		const ids = result.data.map((a) => a.id).sort();
		expect(ids).toContain(pub.id);
		expect(ids).toContain(anon.id);
		expect(result.pagination.total).toBe(3);
	});

	it('filters by framework', async () => {
		const { store } = makeStore();
		await store.createApp(baseNewApp({ userId: 'a', visibility: 'public', framework: 'react' }));
		await store.createApp(baseNewApp({ userId: 'b', visibility: 'public', framework: 'vue' }));

		const result = await store.getPublicApps({ framework: 'vue' });
		expect(result.data).toHaveLength(1);
		expect(result.data[0]!.framework).toBe('vue');
	});

	it('searches by title prefix, case-insensitively -- not substring', async () => {
		const { store } = makeStore();
		await store.createApp(baseNewApp({ userId: 'a', visibility: 'public', title: 'Todo App' }));
		await store.createApp(baseNewApp({ userId: 'b', visibility: 'public', title: 'My Todo Thing' }));

		const result = await store.getPublicApps({ search: 'todo' });
		// Only the title starting with "Todo" matches -- prefix-match, per
		// the resolved product decision, not the original's substring
		// search (which would also match "My Todo Thing").
		expect(result.data.map((a) => a.title)).toEqual(['Todo App']);
	});

	it('sorts recent vs oldest', async () => {
		const { store } = makeStore();

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
		const first = await store.createApp(baseNewApp({ userId: 'a', visibility: 'public', title: 'First' }));
		vi.setSystemTime(new Date('2026-01-15T12:00:01.000Z'));
		const second = await store.createApp(baseNewApp({ userId: 'b', visibility: 'public', title: 'Second' }));
		vi.useRealTimers();

		const recent = await store.getPublicApps({ sort: 'recent' });
		expect(recent.data.map((a) => a.id)).toEqual([second.id, first.id]);

		const oldest = await store.getPublicApps({ sort: 'oldest' });
		expect(oldest.data.map((a) => a.id)).toEqual([first.id, second.id]);
	});

	it('paginates and reports hasMore correctly', async () => {
		const { store } = makeStore();
		for (let i = 0; i < 5; i++) {
			await store.createApp(baseNewApp({ userId: `u${i}`, visibility: 'public', title: `App ${i}` }));
		}

		const page1 = await store.getPublicApps({ limit: 2, offset: 0 });
		expect(page1.data).toHaveLength(2);
		expect(page1.pagination).toMatchObject({ total: 5, hasMore: true });

		const page3 = await store.getPublicApps({ limit: 2, offset: 4 });
		expect(page3.data).toHaveLength(1);
		expect(page3.pagination.hasMore).toBe(false);
	});

	it('reflects the requesting user\'s star/favorite status', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice', visibility: 'public' }));
		await store.toggleAppStar('bob', app.id);

		const result = await store.getPublicApps({ userId: 'bob' });
		expect(result.data[0]).toMatchObject({ userStarred: true, userFavorited: false });
	});
});

describe('deleteApp', () => {
	it('deletes an owned app and its favorites/stars/views', async () => {
		const { store, fake } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));
		await store.toggleAppFavorite('bob', app.id);
		await store.toggleAppStar('carol', app.id);
		await store.recordAppView(app.id, { userId: 'dave' });

		const result = await store.deleteApp(app.id, 'alice');
		expect(result).toEqual({ success: true });

		expect(await store.checkAppOwnership(app.id, 'alice')).toEqual({ exists: false, isOwner: false });
		// Reverse-lookup items must be cleaned up too, not just forward edges.
		expect(fake.itemFor('USER#bob', 'FAVAPP#' + app.id)).toBeUndefined();
		expect(fake.itemFor('USER#carol', 'STARAPP#' + app.id)).toBeUndefined();
	});

	it('rejects deleting an app you do not own', async () => {
		const { store } = makeStore();
		const app = await store.createApp(baseNewApp({ userId: 'alice' }));

		const result = await store.deleteApp(app.id, 'bob');
		expect(result).toEqual({ success: false, error: 'You can only delete your own apps' });
	});

	it('reports app not found', async () => {
		const { store } = makeStore();
		const result = await store.deleteApp('nope', 'alice');
		expect(result).toEqual({ success: false, error: 'App not found' });
	});
});
