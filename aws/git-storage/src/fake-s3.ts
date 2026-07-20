/**
 * Minimal in-memory fake for the subset of S3Client's API S3FS actually
 * uses. No local S3 emulator (LocalStack, etc.) was available in the
 * environment this was written in, so this stands in for one — it's
 * enough to exercise real multi-step workflows (write, read back, list,
 * rename, delete) against actual stored state, rather than only
 * asserting individual S3 calls were made with the right shape.
 *
 * Deliberately not a general-purpose S3 mock: only implements what
 * S3FS calls, with S3's real semantics for the parts that matter here
 * (Delimiter-scoped ListObjectsV2, HeadObject 404 as a thrown NotFound).
 */

import {
	GetObjectCommand,
	PutObjectCommand,
	HeadObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

interface StoredObject {
	body: Uint8Array;
	metadata?: Record<string, string>;
	lastModified: Date;
}

export class FakeS3Client {
	private readonly objects = new Map<string, StoredObject>();

	get size(): number {
		return this.objects.size;
	}

	has(key: string): boolean {
		return this.objects.has(key);
	}

	async send(command: unknown): Promise<unknown> {
		if (command instanceof PutObjectCommand) {
			const { Key, Body, Metadata } = command.input;
			if (!Key) throw new Error('PutObjectCommand requires Key');
			this.objects.set(Key, {
				body: toBytes(Body),
				metadata: Metadata,
				lastModified: new Date(),
			});
			return {};
		}

		if (command instanceof GetObjectCommand) {
			const obj = this.objects.get(command.input.Key ?? '');
			if (!obj) throwNotFound();
			return {
				Body: Readable.from(Buffer.from(obj.body)),
				Metadata: obj.metadata,
				LastModified: obj.lastModified,
			};
		}

		if (command instanceof HeadObjectCommand) {
			const obj = this.objects.get(command.input.Key ?? '');
			if (!obj) throwNotFound();
			return {
				Metadata: obj.metadata,
				LastModified: obj.lastModified,
				ContentLength: obj.body.length,
			};
		}

		if (command instanceof DeleteObjectsCommand) {
			for (const o of command.input.Delete?.Objects ?? []) {
				if (o.Key) this.objects.delete(o.Key);
			}
			return {};
		}

		if (command instanceof CopyObjectCommand) {
			const sourceKey = decodeURIComponent(
				(command.input.CopySource ?? '').split('/').slice(1).join('/'),
			);
			const source = this.objects.get(sourceKey);
			if (!source) throwNotFound();
			this.objects.set(command.input.Key ?? '', { ...source });
			return {};
		}

		if (command instanceof ListObjectsV2Command) {
			const { Prefix = '', Delimiter, ContinuationToken, MaxKeys } =
				command.input;
			const allKeys = Array.from(this.objects.keys())
				.filter((k) => k.startsWith(Prefix))
				.sort();

			if (!Delimiter) {
				const startIndex = ContinuationToken
					? allKeys.indexOf(ContinuationToken) + 1
					: 0;
				const page = MaxKeys
					? allKeys.slice(startIndex, startIndex + MaxKeys)
					: allKeys.slice(startIndex);
				const truncated = MaxKeys
					? startIndex + MaxKeys < allKeys.length
					: false;
				return {
					Contents: page.map((Key) => ({
						Key,
						Size: this.objects.get(Key)!.body.length,
					})),
					IsTruncated: truncated,
					NextContinuationToken: truncated
						? page[page.length - 1]
						: undefined,
				};
			}

			const commonPrefixes = new Set<string>();
			const directContents: string[] = [];
			for (const key of allKeys) {
				const rest = key.slice(Prefix.length);
				const delimIndex = rest.indexOf(Delimiter);
				if (delimIndex === -1) {
					directContents.push(key);
				} else {
					commonPrefixes.add(Prefix + rest.slice(0, delimIndex + 1));
				}
			}
			return {
				CommonPrefixes: Array.from(commonPrefixes).map((Prefix) => ({
					Prefix,
				})),
				Contents: directContents.map((Key) => ({
					Key,
					Size: this.objects.get(Key)!.body.length,
				})),
				IsTruncated: false,
			};
		}

		throw new Error(`FakeS3Client: unhandled command ${command?.constructor?.name}`);
	}
}

function toBytes(body: unknown): Uint8Array {
	if (body instanceof Uint8Array) return body;
	if (typeof body === 'string') return new TextEncoder().encode(body);
	return new Uint8Array(0);
}

function throwNotFound(): never {
	const err = new Error('NotFound');
	err.name = 'NotFound';
	throw err;
}
