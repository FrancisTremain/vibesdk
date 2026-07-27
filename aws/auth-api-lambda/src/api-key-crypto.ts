/**
 * Port of worker/utils/cryptoUtils.ts's generateApiKey/sha256Hash, using
 * Node's built-in crypto instead of Web Crypto (both are available in
 * the Lambda Node20 runtime; node:crypto avoids any doubt about
 * `crypto.subtle` global availability and needs no async/await for the
 * synchronous pieces).
 */

import { createHash, randomBytes } from 'node:crypto';

function base64url(bytes: Buffer): string {
	return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sha256Hash(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function generateApiKey(): { key: string; keyHash: string; keyPreview: string } {
	const key = base64url(randomBytes(32));
	const keyHash = sha256Hash(key);
	const keyPreview = `${key.slice(0, 8)}...${key.slice(-4)}`;
	return { key, keyHash, keyPreview };
}
