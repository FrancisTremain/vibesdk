import { describe, expect, it, vi } from 'vitest';
import { captureUrl, type BrowserLike, type PageLike } from './capture';

/** goto() fires the console message, same as a real page would emit
 *  console output while it loads -- guarantees the emit happens after
 *  on('console', ...) was registered, no timing race with the test. */
function fakePage(opts: { gotoThrows?: Error; emitOnGoto?: { type: string; text: string } } = {}): PageLike {
	let consoleHandler: ((m: { type(): string; text(): string }) => void) | undefined;
	return {
		on: vi.fn((event, handler) => {
			if (event === 'console') consoleHandler = handler;
		}),
		goto: vi.fn(async () => {
			if (opts.gotoThrows) throw opts.gotoThrows;
			if (opts.emitOnGoto) consoleHandler?.({ type: () => opts.emitOnGoto!.type, text: () => opts.emitOnGoto!.text });
		}),
		screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
		waitForTimeout: vi.fn(async () => {}),
	};
}

function fakeBrowser(page: PageLike) {
	const closeMock = vi.fn(async () => {});
	const browser: BrowserLike = { newPage: vi.fn(async () => page), close: closeMock };
	return { browser, closeMock, newPage: browser.newPage as ReturnType<typeof vi.fn> };
}

describe('captureUrl', () => {
	it('navigates, screenshots, and returns console output emitted during the load', async () => {
		const page = fakePage({ emitOnGoto: { type: 'log', text: 'hello from the page' } });
		const { browser, closeMock } = fakeBrowser(page);

		const result = await captureUrl({ url: 'http://example.com' }, async () => browser);

		expect(page.goto).toHaveBeenCalledWith('http://example.com', { waitUntil: 'networkidle', timeout: 30_000 });
		expect(result.screenshotPng).toEqual(new Uint8Array([1, 2, 3]));
		expect(result.consoleLogs).toEqual([{ type: 'log', text: 'hello from the page', timestamp: expect.any(Number) }]);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('uses the default viewport when none is given, and a custom one when it is', async () => {
		const { browser, newPage } = fakeBrowser(fakePage());

		await captureUrl({ url: 'http://example.com' }, async () => browser);
		expect(newPage).toHaveBeenCalledWith({ viewport: { width: 1280, height: 800 } });

		await captureUrl({ url: 'http://example.com', viewport: { width: 375, height: 667 } }, async () => browser);
		expect(newPage).toHaveBeenLastCalledWith({ viewport: { width: 375, height: 667 } });
	});

	it('waits the requested extra time before screenshotting when waitSeconds is given', async () => {
		const page = fakePage();
		const { browser } = fakeBrowser(page);
		await captureUrl({ url: 'http://example.com', waitSeconds: 2 }, async () => browser);
		expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
	});

	it('closes the browser even when navigation throws', async () => {
		const page = fakePage({ gotoThrows: new Error('nav failed') });
		const { browser, closeMock } = fakeBrowser(page);

		await expect(captureUrl({ url: 'http://example.com' }, async () => browser)).rejects.toThrow('nav failed');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});
