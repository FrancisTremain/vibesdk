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

export async function createHarnessSession(
	sessionId: string,
	userPrompt: string,
	sandboxControlUrl: string,
	sandboxControlSecret: string,
	userId?: string,
	useUserCredentials?: boolean,
	fetchImpl: typeof fetch = fetch,
): Promise<HarnessSessionStatus> {
	return call(
		'POST',
		'/api/harness/sessions',
		{ sessionId, userPrompt, sandboxControlUrl, sandboxControlSecret, userId, useUserCredentials },
		fetchImpl,
	);
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
