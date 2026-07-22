/**
 * Port of worker/api/controllers/githubExporter/controller.ts's
 * `signState`/`verifyState` -- a short-lived signed JWT carrying the
 * export request across the OAuth redirect round trip (GitHub doesn't
 * give this Lambda any other way to correlate the callback with the
 * request that started it). Same `jose` library, same HS256 + 10-minute
 * expiry.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const STATE_EXPIRY = '10m';

export interface GitHubExportStatePayload extends JWTPayload {
	sessionId: string;
	repositoryName: string;
	description?: string;
	isPrivate?: boolean;
	returnUrl: string;
}

export async function signExportState(payload: GitHubExportStatePayload, secret: string): Promise<string> {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(STATE_EXPIRY)
		.sign(new TextEncoder().encode(secret));
}

export async function verifyExportState(token: string, secret: string): Promise<GitHubExportStatePayload | null> {
	try {
		const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
		return payload as GitHubExportStatePayload;
	} catch {
		return null;
	}
}
