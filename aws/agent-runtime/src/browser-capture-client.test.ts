import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureScreenshot } from './browser-capture-client';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	process.env.BROWSER_CAPTURE_ENDPOINT = 'https://capture.example.com';
	process.env.BROWSER_CAPTURE_SECRET = 'capture-secret';
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('captureScreenshot', () => {
	it('posts to /api/browser/capture with the shared secret header', async () => {
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://capture.example.com/api/browser/capture');
			expect(init?.headers).toMatchObject({ 'x-browser-capture-secret': 'capture-secret' });
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ sessionId: 'session-1', url: 'http://1.2.3.4:3000' });
			return jsonResponse(200, { success: true, data: { screenshotUrl: 'https://s3.example/x.png', consoleLogs: [] } });
		}) as unknown as typeof fetch;

		const result = await captureScreenshot('session-1', 'http://1.2.3.4:3000', undefined, undefined, fetchImpl);
		expect(result).toEqual({ screenshotUrl: 'https://s3.example/x.png', consoleLogs: [] });
	});

	it('throws with the capture Lambda error message on failure', async () => {
		const fetchImpl = (async () => jsonResponse(502, { success: false, error: { message: 'navigation timeout' } })) as unknown as typeof fetch;
		await expect(captureScreenshot('session-1', 'http://1.2.3.4:3000', undefined, undefined, fetchImpl)).rejects.toThrow(
			'navigation timeout',
		);
	});

	it('throws when not configured', async () => {
		delete process.env.BROWSER_CAPTURE_ENDPOINT;
		delete process.env.BROWSER_CAPTURE_SECRET;
		await expect(captureScreenshot('session-1', 'http://1.2.3.4:3000')).rejects.toThrow(/not configured/);
	});
});
