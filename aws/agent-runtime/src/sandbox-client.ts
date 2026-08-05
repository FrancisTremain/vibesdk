/**
 * HTTP client for aws/sandbox-orchestrator-lambda's `POST
 * /api/sandbox/instances` (createInstance) -- the one operation
 * ./generation.ts needs. Not a full `SandboxServiceClient`
 * implementation; this package only ever creates a fresh instance per
 * generation, it doesn't yet drive files/commands/logs/shutdown on an
 * existing one (there's no "iterate on generated code" flow here yet
 * -- see this package's README).
 *
 * Authenticated the same way aws/sandbox-orchestrator-lambda expects
 * its own caller to authenticate: a shared secret header
 * (`X-Orchestrator-Secret`), since this Lambda has no static egress IP
 * to be source-IP-allowlisted either -- same reasoning chain as that
 * package's own README.
 */

import { randomUUID } from 'node:crypto';
import type { GeneratedFile } from './generation';

export interface SandboxInstanceResult {
	success: boolean;
	runId?: string;
	previewURL?: string;
	/** ALB-fronted HTTPS hostname (aws/infra/sandbox/alb.tf) -- what actually
	 *  gets shown to the browser. previewURL stays the raw task IP:3000 and
	 *  must keep being used for deriveControlUrl (./harness-generation.ts);
	 *  the ALB only proxies the dev-server port, not the control-plane one.
	 *  Absent if ALB route registration failed -- the orchestrator degrades
	 *  gracefully rather than failing instance creation over it, so callers
	 *  should fall back to previewURL when this is missing. */
	externalPreviewURL?: string;
	message?: string;
	error?: { message: string } | string;
}

interface SandboxInstanceStatus {
	runId?: string;
	pending: boolean;
	isHealthy: boolean;
	previewURL?: string;
	externalPreviewURL?: string;
	error?: string;
}

function endpointAndSecret(): { endpoint: string; secret: string } {
	const endpoint = process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
	const secret = process.env.SANDBOX_ORCHESTRATOR_SECRET;
	if (!endpoint || !secret) {
		throw new Error(
			'Sandbox orchestrator not configured (SANDBOX_ORCHESTRATOR_ENDPOINT / SANDBOX_ORCHESTRATOR_SECRET) -- see aws/infra/agent-runtime.tf.',
		);
	}
	return { endpoint: endpoint.replace(/\/$/, ''), secret };
}

// API Gateway HTTP APIs have a hard, non-configurable 29s integration
// timeout -- ECS RunTask + wait for networking + the sandbox's own
// bootstrap (dependency install + dev-server start) can legitimately take
// well past that (confirmed live: 82s for a single createInstance call
// that ultimately succeeded). The Lambda keeps running to completion
// regardless of API Gateway giving up on the client, and persists the
// real end state, but the caller only ever sees a 503 with no body.
// Retrying the POST would hit 409 (the instanceId below already exists);
// instead fall back to polling the status route, which is a cheap
// DynamoDB read (plus one proxied call to the sandbox's own control
// plane) that reflects whatever the still-running Lambda eventually wrote
// -- same pattern as ./harness-client.ts's createHarnessSession.
const INSTANCE_CREATE_POLL_INTERVAL_MS = 3_000;
const INSTANCE_CREATE_POLL_TIMEOUT_MS = 120_000;

export async function createSandboxInstance(
	files: GeneratedFile[],
	projectName: string,
	initCommand: string,
	fetchImpl: typeof fetch = fetch,
): Promise<SandboxInstanceResult> {
	const { endpoint, secret } = endpointAndSecret();
	// Generated up front, not left to the orchestrator, so a poll-fallback
	// after a 503 knows which instance to poll for -- the whole point is
	// that the synchronous response below might never arrive.
	const instanceId = randomUUID();

	try {
		const res = await fetchImpl(`${endpoint}/api/sandbox/instances`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-orchestrator-secret': secret },
			body: JSON.stringify({ files, projectName, initCommand, instanceId }),
		});

		const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: SandboxInstanceResult; error?: { message: string } };
		if (!res.ok || !json.success) {
			const message = typeof json.error === 'object' ? json.error?.message : json.error;
			throw new Error(message ?? `Sandbox instance creation failed (${res.status})`);
		}

		return { success: true, ...json.data };
	} catch {
		return pollUntilReady(instanceId, fetchImpl);
	}
}

async function getSandboxInstanceStatus(instanceId: string, fetchImpl: typeof fetch): Promise<SandboxInstanceStatus> {
	const { endpoint, secret } = endpointAndSecret();
	const res = await fetchImpl(`${endpoint}/api/sandbox/instances/${encodeURIComponent(instanceId)}/status`, {
		method: 'GET',
		headers: { 'x-orchestrator-secret': secret },
	});
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: SandboxInstanceStatus; error?: { message: string } };
	if (!res.ok || !json.success || !json.data) {
		const message = typeof json.error === 'object' ? json.error?.message : json.error;
		throw new Error(message ?? `Sandbox status check failed (${res.status})`);
	}
	return json.data;
}

async function pollUntilReady(instanceId: string, fetchImpl: typeof fetch): Promise<SandboxInstanceResult> {
	const deadline = Date.now() + INSTANCE_CREATE_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, INSTANCE_CREATE_POLL_INTERVAL_MS));
		const status = await getSandboxInstanceStatus(instanceId, fetchImpl).catch(() => undefined);
		if (status?.error) {
			throw new Error(status.error);
		}
		if (status && !status.pending) {
			return {
				success: true,
				runId: instanceId,
				previewURL: status.previewURL,
				externalPreviewURL: status.externalPreviewURL,
			};
		}
	}
	throw new Error('Sandbox instance did not become ready in time');
}

/** Used by ./harness-generation.ts to pull the final file set out of a sandbox once the harness reports its generation turn done -- the harness writes files via its own tool calls, so this runtime never holds them until this point. */
export async function getSandboxFiles(
	instanceId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ filePath: string; fileContents: string }[]> {
	const endpoint = process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
	const secret = process.env.SANDBOX_ORCHESTRATOR_SECRET;
	if (!endpoint || !secret) {
		throw new Error(
			'Sandbox orchestrator not configured (SANDBOX_ORCHESTRATOR_ENDPOINT / SANDBOX_ORCHESTRATOR_SECRET) -- see aws/infra/agent-runtime.tf.',
		);
	}

	const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/api/sandbox/instances/${encodeURIComponent(instanceId)}/files`, {
		method: 'GET',
		headers: { 'x-orchestrator-secret': secret },
	});
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { files?: { filePath: string; fileContents: string }[] }; error?: { message: string } };
	if (!res.ok || !json.success) {
		throw new Error(json.error?.message ?? `Fetching sandbox files failed (${res.status})`);
	}
	return json.data?.files ?? [];
}
