export interface UserStats {
	appCount: number;
	publicAppCount: number;
	favoriteCount: number;
	totalLikesReceived: number;
	totalViewsReceived: number;
	streakDays: number;
	achievements: string[];
}

export interface UserActivity {
	type: 'created' | 'updated' | 'favorited';
	title: string;
	timestamp: number | null;
	metadata: Record<string, unknown>;
}

/** The subset of aws/db-apps's App item shape this package reads. Kept
 *  as a local minimal type rather than a cross-package dependency on
 *  vibesdk-db-apps -- see the module comment in analytics-store.ts for
 *  why, and the coupling this implies. */
export interface AppSummary {
	id: string;
	title: string;
	userId: string | null;
	visibility: 'private' | 'public';
	createdAt: number;
	updatedAt: number;
	favoriteCount: number;
	viewCount: number;
}
