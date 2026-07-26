/**
 * Port of RateLimitService.getUniversalIdentifier/getRequestIdentifier
 * (worker/services/rate-limit/rateLimits.ts) for the one caller that
 * needs it here, GET /api/apps/public. Same precedence: an
 * authenticated user's own id, else a hash of their raw bearer/cookie
 * token (even if that token turns out not to validate -- matching the
 * original, which hashes before validating), else client IP.
 *
 * IP source: API Gateway's `sourceIp` is CloudFront's own edge IP, not
 * the real client, since CloudFront is a custom (not VPC-origin)
 * origin here -- same reason frontend.tf's origin-request policy
 * forwards `X-Forwarded-For`. CloudFront always prepends the true
 * client IP as the first entry when forwarding to a custom origin, so
 * that's used first, with `sourceIp` as a last-resort fallback (e.g. a
 * direct execute-api request that somehow got this far).
 */

import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function extractRawToken(event: APIGatewayProxyEventV2): string | null {
	const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
	if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
	const cookieEntry = event.cookies?.find((c) => c.trim().startsWith('accessToken='));
	return cookieEntry ? decodeURIComponent(cookieEntry.split('=').slice(1).join('=')) : null;
}

function extractClientIp(event: APIGatewayProxyEventV2): string {
	const xff = event.headers?.['x-forwarded-for'] ?? event.headers?.['X-Forwarded-For'];
	const firstHop = xff?.split(',')[0]?.trim();
	return firstHop || event.requestContext.http.sourceIp || 'unknown';
}

export function getPublicAppsRateLimitIdentifier(event: APIGatewayProxyEventV2, userId: string | undefined): string {
	if (userId) return `user:${userId}`;

	const token = extractRawToken(event);
	if (token) {
		const hash = createHash('sha256').update(token).digest('hex');
		return `token:${hash.slice(0, 16)}`;
	}

	return `ip:${extractClientIp(event)}`;
}
