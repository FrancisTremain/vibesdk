/**
 * Field shapes ported from worker/database/schema.ts's `apps` table plus
 * the result types AppService's ported surface uses, from
 * worker/database/types.ts. Same shapes; storage model changes, not
 * the data.
 */

export type Visibility = 'private' | 'public';
export type AppStatus = 'generating' | 'completed';

export interface App {
	id: string;
	title: string;
	description: string | null;
	iconUrl: string | null;
	originalPrompt: string;
	finalPrompt: string | null;
	framework: string | null;
	userId: string | null;
	sessionToken: string | null;
	visibility: Visibility;
	status: AppStatus;
	deploymentId: string | null;
	githubRepositoryUrl: string | null;
	githubRepositoryVisibility: 'public' | 'private' | null;
	isArchived: boolean;
	isFeatured: boolean;
	version: number;
	parentAppId: string | null;
	previewVersion: number;
	screenshotUrl: string | null;
	screenshotCapturedAt: number | null;
	createdAt: number;
	updatedAt: number;
	lastDeployedAt: number | null;
	/** Maintained counters -- not in the D1 schema, which computes these
	 *  live via COUNT queries. See identity-store.ts's module comment
	 *  for the general "genuine improvement" pattern this follows. */
	starCount: number;
	favoriteCount: number;
	viewCount: number;
}

export type NewApp = Omit<
	App,
	'id' | 'createdAt' | 'updatedAt' | 'starCount' | 'favoriteCount' | 'viewCount'
> &
	Partial<Pick<App, 'createdAt' | 'updatedAt'>>;

export interface OwnershipResult {
	exists: boolean;
	isOwner: boolean;
	visibility?: Visibility | null;
}

export interface AppVisibilityUpdateResult {
	success: boolean;
	error?: string;
	app?: Pick<App, 'id' | 'title' | 'visibility' | 'updatedAt'>;
}

export interface FavoriteToggleResult {
	isFavorite: boolean;
}

export interface AppWithFavoriteStatus extends App {
	isFavorite: boolean;
}

export interface EnhancedAppData extends App {
	userStarred: boolean;
	userFavorited: boolean;
}

export interface PaginationInfo {
	limit: number;
	offset: number;
	total: number;
	hasMore: boolean;
}

export interface PaginatedResult<T> {
	data: T[];
	pagination: PaginationInfo;
}

export interface ViewerIdentity {
	userId?: string;
	ipAddress?: string;
	userAgent?: string;
}

export interface PublicAppQueryOptions {
	limit?: number;
	offset?: number;
	sort?: 'recent' | 'oldest';
	framework?: string;
	search?: string;
	userId?: string;
}
