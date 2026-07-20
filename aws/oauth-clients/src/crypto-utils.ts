/**
 * Port of `base64url` from worker/utils/cryptoUtils.ts, used only for the
 * PKCE code-challenge digest. Unchanged -- standard Web Crypto + `btoa`,
 * identical on Node 20 and Cloudflare Workers.
 */
export function base64url(buffer: Uint8Array): string {
	if (buffer.length === 0) {
		return '';
	}

	const CHUNK_SIZE = 8192;
	let result = '';

	for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
		const chunk = buffer.slice(i, i + CHUNK_SIZE);
		const chars = Array.from(chunk, (byte) => String.fromCharCode(byte));
		result += btoa(chars.join(''));
	}

	return result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
