/**
 * Real, deterministic navigate-and-capture logic -- the AWS
 * replacement for worker/agents/core/codingAgent.ts's
 * captureScreenshot/captureBrowserConsoleLogs (CF's BROWSER binding,
 * @cloudflare/puppeteer). One page load, one screenshot, whatever
 * console output happened during that load -- no agentic loop, no
 * model call. See this package's README for why an agentic
 * computer-use tool is the wrong shape for this.
 *
 * Structured against `BrowserLike`/`PageLike` (the small subset of
 * Playwright's real `Browser`/`Page` this function actually calls)
 * rather than importing `playwright-core` directly here, so this
 * logic is unit-testable without a real Chromium -- see ./browser.ts
 * for the real Playwright-backed launcher and capture.test.ts for the
 * fake used in tests.
 */

export interface ConsoleLogEntry {
	type: string;
	text: string;
	timestamp: number;
}

export interface CaptureRequest {
	url: string;
	viewport?: { width: number; height: number };
	/** Extra time to let the page run (and emit console output) after load, in seconds. */
	waitSeconds?: number;
}

export interface CaptureResult {
	screenshotPng: Uint8Array;
	consoleLogs: ConsoleLogEntry[];
}

export interface ConsoleMessageLike {
	type(): string;
	text(): string;
}

export interface PageLike {
	on(event: 'console', handler: (message: ConsoleMessageLike) => void): void;
	goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<unknown>;
	screenshot(options: { type: 'png' }): Promise<Uint8Array>;
	waitForTimeout(ms: number): Promise<void>;
}

export interface BrowserLike {
	newPage(options: { viewport: { width: number; height: number } }): Promise<PageLike>;
	close(): Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;

export async function captureUrl(request: CaptureRequest, launchBrowser: () => Promise<BrowserLike>): Promise<CaptureResult> {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: request.viewport ?? DEFAULT_VIEWPORT });

		const consoleLogs: ConsoleLogEntry[] = [];
		page.on('console', (message) => {
			consoleLogs.push({ type: message.type(), text: message.text(), timestamp: Date.now() });
		});

		await page.goto(request.url, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
		if (request.waitSeconds) {
			await page.waitForTimeout(request.waitSeconds * 1000);
		}

		const screenshotPng = await page.screenshot({ type: 'png' });
		return { screenshotPng, consoleLogs };
	} finally {
		await browser.close();
	}
}
