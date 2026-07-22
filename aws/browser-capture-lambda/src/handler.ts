/**
 * API Gateway HTTP API (v2) Lambda: one route, `POST /api/browser/capture`.
 * Navigates to a URL (typically a running sandbox preview), captures a
 * screenshot and whatever console output happened during the load, and
 * returns a presigned S3 URL for the screenshot plus the console log
 * entries. See ./capture.ts for why this is deterministic Playwright
 * automation, not an agentic computer-use loop.
 *
 * Authenticated the same way aws/sandbox-orchestrator-lambda's own
 * caller authenticates to it: a shared secret header
 * (`X-Browser-Capture-Secret`) rather than source-IP restriction,
 * since this Lambda's caller (aws/agent-runtime) has no static egress
 * IP either.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { captureUrl, type CaptureRequest } from './capture';
import { launchBrowser } from './browser';
import { uploadScreenshot } from './screenshot-storage';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
	return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(message: string, statusCode = 500): APIGatewayProxyResultV2 {
	return jsonResponse(statusCode, { success: false, error: { message } });
}

function isAuthorized(event: APIGatewayProxyEventV2): boolean {
	const secret = requireEnv('BROWSER_CAPTURE_SECRET');
	return event.headers?.['x-browser-capture-secret'] === secret;
}

let cachedS3: S3Client | null = null;
function getS3(): S3Client {
	if (!cachedS3) cachedS3 = new S3Client({});
	return cachedS3;
}

/** Test-only override, same pattern as the sibling Lambda packages' setDdbClientForTests. */
export function setS3ClientForTests(client: S3Client | null): void {
	cachedS3 = client;
}

async function handleCapture(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	let body: { sessionId?: string; url?: string; viewport?: { width: number; height: number }; waitSeconds?: number };
	try {
		body = JSON.parse(event.body ?? '{}');
	} catch {
		return errorResponse('Invalid JSON body', 400);
	}

	if (!body.sessionId) return errorResponse('sessionId is required', 400);
	if (!body.url) return errorResponse('url is required', 400);

	const request: CaptureRequest = { url: body.url, viewport: body.viewport, waitSeconds: body.waitSeconds };

	try {
		const { screenshotPng, consoleLogs } = await captureUrl(request, launchBrowser);
		const screenshotUrl = await uploadScreenshot(getS3(), requireEnv('SCREENSHOTS_BUCKET'), body.sessionId, screenshotPng);
		return jsonResponse(200, { success: true, data: { screenshotUrl, consoleLogs } });
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : 'Capture failed', 502);
	}
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	if (!isAuthorized(event)) return errorResponse('Forbidden', 403);

	switch (event.routeKey) {
		case 'POST /api/browser/capture':
			return handleCapture(event);
		default:
			return errorResponse('Not found', 404);
	}
}
