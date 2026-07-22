/**
 * Real Chromium launcher -- the one part of this package that isn't
 * unit-tested (needs an actual browser binary; see this package's
 * README for why that binary comes from a separately-published Lambda
 * Layer rather than being bundled into this function's own zip).
 *
 * `@sparticuz/chromium` and `playwright-core` are both marked
 * `--external` in the esbuild bundle (package.json's `build` script)
 * -- they're expected to be present in the layer at
 * `/opt/nodejs/node_modules/`, not in this function's own deployment
 * package.
 */

import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium, type Browser } from 'playwright-core';
import type { BrowserLike } from './capture';

export async function launchBrowser(): Promise<BrowserLike> {
	const executablePath = await chromium.executablePath();
	const browser: Browser = await playwrightChromium.launch({
		args: chromium.args,
		executablePath,
		headless: true,
	});
	return browser as unknown as BrowserLike;
}
