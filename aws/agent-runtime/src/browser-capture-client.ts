/**
 * HTTP client for aws/browser-capture-lambda's `POST /api/browser/capture`
 * -- what the `capture_screenshot` message actually calls. Same
 * shared-secret auth shape as ./sandbox-client.ts's call to
 * aws/sandbox-orchestrator-lambda (this Lambda has no static egress
 * IP to be source-IP-allowlisted either).
 */

export interface ConsoleLogEntry {
	type: string;
	text: string;
	timestamp: number;
}

export interface CaptureResult {
	screenshotUrl: string;
	consoleLogs: ConsoleLogEntry[];
}

export async function captureScreenshot(
	sessionId: string,
	url: string,
	viewport?: { width: number; height: number },
	waitSeconds?: number,
	fetchImpl: typeof fetch = fetch,
): Promise<CaptureResult> {
	const endpoint = process.env.BROWSER_CAPTURE_ENDPOINT;
	const secret = process.env.BROWSER_CAPTURE_SECRET;
	if (!endpoint || !secret) {
		throw new Error(
			'Browser capture not configured (BROWSER_CAPTURE_ENDPOINT / BROWSER_CAPTURE_SECRET) -- see aws/infra/browser-capture.tf.',
		);
	}

	const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/api/browser/capture`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-browser-capture-secret': secret },
		body: JSON.stringify({ sessionId, url, viewport, waitSeconds }),
	});

	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: CaptureResult; error?: { message: string } };
	if (!res.ok || !json.success || !json.data) {
		throw new Error(json.error?.message ?? `Screenshot capture failed (${res.status})`);
	}
	return json.data;
}
