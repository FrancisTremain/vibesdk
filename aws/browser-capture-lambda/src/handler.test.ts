import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

process.env.BROWSER_CAPTURE_SECRET = 'capture-secret';
process.env.SCREENSHOTS_BUCKET = 'vibesdk-screenshots-test';

const captureUrlMock = vi.fn();
vi.mock('./capture', () => ({ captureUrl: (...args: unknown[]) => captureUrlMock(...args) }));
vi.mock('./browser', () => ({ launchBrowser: vi.fn() }));

const uploadScreenshotMock = vi.fn();
vi.mock('./screenshot-storage', () => ({ uploadScreenshot: (...args: unknown[]) => uploadScreenshotMock(...args) }));

const { handler } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey: 'POST /api/browser/capture',
		rawPath: '',
		rawQueryString: '',
		headers: { 'x-browser-capture-secret': 'capture-secret' },
		isBase64Encoded: false,
		requestContext: {} as APIGatewayProxyEventV2['requestContext'],
		...overrides,
	} as APIGatewayProxyEventV2;
}

beforeEach(() => {
	captureUrlMock.mockReset();
	uploadScreenshotMock.mockReset();
});

describe('auth', () => {
	it('rejects requests without the correct secret', async () => {
		const result = asStructured(await handler(event({ headers: { 'x-browser-capture-secret': 'wrong' } })));
		expect(result.statusCode).toBe(403);
		expect(captureUrlMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/browser/capture', () => {
	it('captures the URL and returns a screenshot URL plus console logs', async () => {
		captureUrlMock.mockResolvedValue({
			screenshotPng: new Uint8Array([1, 2, 3]),
			consoleLogs: [{ type: 'error', text: 'boom', timestamp: 123 }],
		});
		uploadScreenshotMock.mockResolvedValue('https://vibesdk-screenshots-test.s3.amazonaws.com/screenshots/session-1/1.png?sig=x');

		const result = asStructured(
			await handler(event({ body: JSON.stringify({ sessionId: 'session-1', url: 'http://1.2.3.4:3000' }) })),
		);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body!) as { success: boolean; data: { screenshotUrl: string; consoleLogs: unknown[] } };
		expect(body.success).toBe(true);
		expect(body.data.screenshotUrl).toContain('vibesdk-screenshots-test');
		expect(body.data.consoleLogs).toEqual([{ type: 'error', text: 'boom', timestamp: 123 }]);
		expect(uploadScreenshotMock).toHaveBeenCalledWith(expect.anything(), 'vibesdk-screenshots-test', 'session-1', expect.any(Uint8Array));
	});

	it('rejects a request missing url', async () => {
		const result = asStructured(await handler(event({ body: JSON.stringify({ sessionId: 'session-1' }) })));
		expect(result.statusCode).toBe(400);
		expect(captureUrlMock).not.toHaveBeenCalled();
	});

	it('rejects a request missing sessionId', async () => {
		const result = asStructured(await handler(event({ body: JSON.stringify({ url: 'http://1.2.3.4:3000' }) })));
		expect(result.statusCode).toBe(400);
	});

	it('returns 502 when capture fails', async () => {
		captureUrlMock.mockRejectedValue(new Error('navigation timeout'));
		const result = asStructured(
			await handler(event({ body: JSON.stringify({ sessionId: 'session-1', url: 'http://1.2.3.4:3000' }) })),
		);
		expect(result.statusCode).toBe(502);
		const body = JSON.parse(result.body!) as { error: { message: string } };
		expect(body.error.message).toContain('navigation timeout');
	});
});

describe('unknown route', () => {
	it('returns 404', async () => {
		const result = asStructured(await handler(event({ routeKey: 'GET /nope' })));
		expect(result.statusCode).toBe(404);
	});
});
