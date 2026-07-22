import { describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { uploadScreenshot } from './screenshot-storage';

const s3Mock = mockClient(S3Client);

describe('uploadScreenshot', () => {
	it('uploads the PNG bytes under a per-session key and returns a URL', async () => {
		s3Mock.reset();
		s3Mock.on(PutObjectCommand).resolves({});

		const png = new Uint8Array([1, 2, 3]);
		const url = await uploadScreenshot(
			new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }),
			'test-bucket',
			'session-1',
			png,
		);

		const calls = s3Mock.commandCalls(PutObjectCommand);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args[0]!.input).toMatchObject({ Bucket: 'test-bucket', ContentType: 'image/png' });
		expect(calls[0]!.args[0]!.input.Key).toMatch(/^screenshots\/session-1\/\d+\.png$/);
		expect(calls[0]!.args[0]!.input.Body).toEqual(png);

		// Presigned URL generation doesn't call the network -- it's a
		// local signature computation -- so this just needs to resolve
		// to *a* URL pointing at the bucket/key, not a live HTTP check.
		expect(url).toContain('test-bucket');
	});
});
