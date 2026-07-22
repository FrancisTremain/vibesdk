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

import type { GeneratedFile } from './generation';

export interface SandboxInstanceResult {
	success: boolean;
	runId?: string;
	previewURL?: string;
	message?: string;
	error?: { message: string } | string;
}

export async function createSandboxInstance(
	files: GeneratedFile[],
	projectName: string,
	initCommand: string,
	fetchImpl: typeof fetch = fetch,
): Promise<SandboxInstanceResult> {
	const endpoint = process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
	const secret = process.env.SANDBOX_ORCHESTRATOR_SECRET;
	if (!endpoint || !secret) {
		throw new Error(
			'Sandbox orchestrator not configured (SANDBOX_ORCHESTRATOR_ENDPOINT / SANDBOX_ORCHESTRATOR_SECRET) -- see aws/infra/agent-runtime.tf.',
		);
	}

	const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/api/sandbox/instances`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-orchestrator-secret': secret },
		body: JSON.stringify({ files, projectName, initCommand }),
	});

	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: SandboxInstanceResult; error?: { message: string } };
	if (!res.ok || !json.success) {
		const message = typeof json.error === 'object' ? json.error?.message : json.error;
		throw new Error(message ?? `Sandbox instance creation failed (${res.status})`);
	}

	return { success: true, ...json.data };
}
