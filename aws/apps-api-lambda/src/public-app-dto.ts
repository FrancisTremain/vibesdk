/**
 * Port of worker/api/controllers/apps/publicAppDto.ts's
 * `toPublicAppListItem` -- the whitelist projection that's the single
 * source of truth for what may leave this Lambda on the public app
 * endpoints (drops the original prompt from listings, internal
 * userId, etc.).
 *
 * Narrower than the original in two ways, both because
 * `vibesdk-db-apps`'s `AppStore` itself doesn't carry this data (see
 * its README for why -- not something this DTO layer could add back):
 * - No `userName`/`userAvatar` -- the original joins these from the
 *   `users` table; `AppStore` doesn't join across tables (each
 *   `aws/db-*` package is scoped to one DynamoDB table).
 * - No `forkCount`/`likeCount` -- `AppStore` doesn't track fork/like
 *   counts at all (fork detachment and comment-likes were excluded
 *   from that port).
 */

import type { EnhancedAppData } from 'vibesdk-db-apps';

export interface PublicAppListItem {
	id: string;
	title: string;
	description: string | null;
	iconUrl: string | null;
	framework: string | null;
	visibility: string;
	status: string;
	isFeatured: boolean;
	screenshotUrl: string | null;
	createdAt: number;
	updatedAt: number;
	lastDeployedAt: number | null;
	githubRepositoryUrl: string | null;
	githubRepositoryVisibility: 'public' | 'private' | null;
	starCount: number;
	viewCount: number;
	userStarred: boolean;
	userFavorited: boolean;
	updatedAtFormatted: string;
	createdAtFormatted: string;
}

function publicGithubFields(
	app: Pick<EnhancedAppData, 'githubRepositoryUrl' | 'githubRepositoryVisibility'>,
): Pick<PublicAppListItem, 'githubRepositoryUrl' | 'githubRepositoryVisibility'> {
	const isPublicRepo = app.githubRepositoryVisibility === 'public';
	return {
		githubRepositoryUrl: isPublicRepo ? app.githubRepositoryUrl : null,
		githubRepositoryVisibility: isPublicRepo ? app.githubRepositoryVisibility : null,
	};
}

export function toPublicAppListItem(app: EnhancedAppData): PublicAppListItem {
	return {
		id: app.id,
		title: app.title,
		description: app.description,
		iconUrl: app.iconUrl,
		framework: app.framework,
		visibility: app.visibility,
		status: app.status,
		isFeatured: app.isFeatured,
		screenshotUrl: app.screenshotUrl,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
		lastDeployedAt: app.lastDeployedAt,
		...publicGithubFields(app),
		starCount: app.starCount,
		viewCount: app.viewCount,
		userStarred: app.userStarred,
		userFavorited: app.userFavorited,
		updatedAtFormatted: formatRelativeTime(app.updatedAt),
		createdAtFormatted: app.createdAt ? formatRelativeTime(app.createdAt) : '',
	};
}

/**
 * Port of worker/utils/timeFormatter.ts's `formatRelativeTime`,
 * unchanged, adapted to take an epoch-ms number (this port's
 * timestamps) instead of a `Date`.
 */
export function formatRelativeTime(epochMs: number | null): string {
	if (!epochMs) return 'Unknown';
	const diffInSeconds = Math.floor((Date.now() - epochMs) / 1000);

	if (diffInSeconds < 60) return 'just now';
	if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
	if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
	if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;
	if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 604800)} weeks ago`;
	if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
	return `${Math.floor(diffInSeconds / 31536000)} years ago`;
}
