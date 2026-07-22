/**
 * Uploads a captured screenshot to S3 and returns a presigned GET URL
 * -- the bucket itself is private (block-public-access, same as
 * aws/infra's git-storage bucket) since a screenshot can contain
 * whatever a generated app's live preview happened to be showing.
 * Screenshots are short-lived debug artifacts, not durable state --
 * see aws/infra/browser-capture.tf's S3 lifecycle rule.
 */

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 1h -- long enough to view/attach, short enough not to matter if leaked in a log line.

export async function uploadScreenshot(
	s3: S3Client,
	bucket: string,
	sessionId: string,
	pngBytes: Uint8Array,
): Promise<string> {
	const key = `screenshots/${sessionId}/${Date.now()}.png`;

	await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pngBytes, ContentType: 'image/png' }));

	return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: PRESIGNED_URL_TTL_SECONDS });
}
