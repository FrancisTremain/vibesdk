/**
 * HTTP client for aws/harness-orchestrator-lambda's session routes --
 * the one caller of that Lambda's API. Same shared-secret-header
 * authentication as ./sandbox-client.ts's call to
 * aws/sandbox-orchestrator-lambda (X-Orchestrator-Secret), since this
 * Lambda has no static egress IP to be source-IP-allowlisted either.
 */

export interface HarnessSessionStatus {
	sessionId?: string;
	agentSessionId?: string;
	phase?: { name: string; status: 'started' | 'completed' };
	done: boolean;
	error?: string;
}

function endpointAndSecret(): { endpoint: string; secret: string } {
	const endpoint = process.env.HARNESS_ORCHESTRATOR_ENDPOINT;
	const secret = process.env.HARNESS_ORCHESTRATOR_SECRET;
	if (!endpoint || !secret) {
		throw new Error(
			'Harness orchestrator not configured (HARNESS_ORCHESTRATOR_ENDPOINT / HARNESS_ORCHESTRATOR_SECRET) -- see aws/infra/agent-runtime.tf.',
		);
	}
	return { endpoint: endpoint.replace(/\/$/, ''), secret };
}

async function call<T>(method: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
	const { endpoint, secret } = endpointAndSecret();
	const res = await fetchImpl(`${endpoint}${path}`, {
		method,
		headers: { 'content-type': 'application/json', 'x-orchestrator-secret': secret },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message: string } };
	if (!res.ok || !json.success) {
		throw new Error(json.error?.message ?? `Harness orchestrator call failed (${res.status})`);
	}
	return json.data as T;
}

// API Gateway HTTP APIs have a hard, non-configurable 29s integration
// timeout. Fargate task launch + ENI/public-IP assignment + the
// container's own boot can legitimately take longer than that -- the
// Lambda keeps running to completion regardless (API Gateway giving up
// doesn't cancel it) and persists the session's real end state, but the
// caller only ever sees a 503 with no body. Retrying the POST would hit
// 409 (we already sent our own sessionId, so the session now exists);
// instead fall back to polling the status route, which is a cheap
// DynamoDB read that reflects whatever the still-running Lambda
// eventually wrote.
const SESSION_START_POLL_INTERVAL_MS = 3_000;
const SESSION_START_POLL_TIMEOUT_MS = 90_000;

export async function createHarnessSession(
	sessionId: string,
	userPrompt: string,
	sandboxControlUrl: string,
	sandboxControlSecret: string,
	userId?: string,
	useUserCredentials?: boolean,
	fetchImpl: typeof fetch = fetch,
	sandboxInstanceId?: string,
): Promise<HarnessSessionStatus> {
	try {
		return await call<HarnessSessionStatus>(
			'POST',
			'/api/harness/sessions',
			{ sessionId, userPrompt, sandboxControlUrl, sandboxControlSecret, userId, useUserCredentials, sandboxInstanceId },
			fetchImpl,
		);
	} catch {
		return pollUntilStarted(sessionId, fetchImpl);
	}
}

async function pollUntilStarted(sessionId: string, fetchImpl: typeof fetch): Promise<HarnessSessionStatus> {
	const deadline = Date.now() + SESSION_START_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, SESSION_START_POLL_INTERVAL_MS));
		const status = await getHarnessStatus(sessionId, fetchImpl).catch(() => undefined);
		const provisioningStatus = (status as { status?: string } | undefined)?.status;
		if (provisioningStatus === 'ERROR') {
			throw new Error(status?.error ?? 'Harness session failed to start');
		}
		if (status && provisioningStatus !== 'PROVISIONING') {
			// The container's own GET /status (aws/agent-harness/src/server.ts)
			// reports agentSessionId/phase/done but has no reason to echo
			// back the orchestrator-level sessionId it doesn't track --
			// createHarnessSession's caller needs it, so fill it in from
			// what we already know we polled for.
			return { ...status, sessionId: status.sessionId ?? sessionId };
		}
	}
	throw new Error('Harness session did not become ready in time');
}

export async function sendHarnessMessage(sessionId: string, content: string, fetchImpl: typeof fetch = fetch): Promise<HarnessSessionStatus> {
	return call('POST', `/api/harness/sessions/${encodeURIComponent(sessionId)}/messages`, { content }, fetchImpl);
}

export async function getHarnessStatus(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<HarnessSessionStatus> {
	return call('GET', `/api/harness/sessions/${encodeURIComponent(sessionId)}/status`, undefined, fetchImpl);
}

export async function recordHarnessActivity(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
	await call('POST', `/api/harness/sessions/${encodeURIComponent(sessionId)}/activity`, undefined, fetchImpl);
}
