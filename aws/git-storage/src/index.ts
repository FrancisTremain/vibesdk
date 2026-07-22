export { S3FS, createS3FS } from './s3-fs';
export type { Stat } from './s3-fs';
export { FakeS3Client } from './fake-s3';

import { S3Client } from '@aws-sdk/client-s3';
import { S3FS } from './s3-fs';
import { FakeS3Client } from './fake-s3';

/**
 * Test-only helper for downstream consumers (e.g. aws/agent-runtime's
 * git-commit.test.ts): an `S3FS` backed by an in-memory `FakeS3Client`,
 * built entirely inside this package so the cross-package `S3Client`
 * type-identity issue `createS3FS`'s real-client path would hit (see
 * that function's doc comment) never comes up in a consumer's test file.
 */
export function createFakeS3FS(bucket: string, keyPrefix: string): { fs: S3FS; client: FakeS3Client } {
	const client = new FakeS3Client();
	const fs = new S3FS(client as unknown as S3Client, bucket, keyPrefix);
	return { fs, client };
}
