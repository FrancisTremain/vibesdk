/**
 * Real implementation of messages.ts's `MessageDeps.startHarnessGeneration`
 * -- what `generate_all` does now that #10 (the phased generation
 * pipeline) is the Agent-SDK-harness design rather than ./generation.ts's
 * single-shot JSON completion. That module is kept as-is (dead code, not
 * deleted -- see its own header) rather than deleted, since it's a
 * documented, tested, honest fallback shape; this module supersedes it
 * as the real `generate_all` path.
 *
 * Flow, reversed from generation.ts's: an EMPTY sandbox instance is
 * created first (no files, a no-op initCommand -- the harness starts
 * the real dev server itself once it has something to run), then a
 * harness session is started against that sandbox's control-plane
 * port directly (not proxied through aws/sandbox-orchestrator-lambda
 * for every tool call -- only this one-time setup goes through it).
 */

import { createSandboxInstance } from './sandbox-client';
import { createHarnessSession, type HarnessSessionStatus } from './harness-client';

export interface HarnessGenerationStart {
	sandboxInstanceId: string;
	previewUrl?: string;
	sandboxControlUrl: string;
	harnessSessionId: string;
	agentSessionId?: string;
	phase?: { name: string; status: 'started' | 'completed' };
	done: boolean;
}

const SANDBOX_CONTROL_PORT = 8080;

/** Derives the sandbox task's control-plane URL from its dev-server preview URL -- both ports are exposed on the same task's public IP (aws/infra/sandbox/main.tf), so no extra lookup is needed. */
function deriveControlUrl(previewUrl: string): string {
	const url = new URL(previewUrl);
	return `http://${url.hostname}:${SANDBOX_CONTROL_PORT}`;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

export async function startHarnessGeneration(
	description: string,
	sessionId: string,
	_userId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<HarnessGenerationStart> {
	const sandbox = await createSandboxInstance([], 'generated-app', 'true', fetchImpl);
	if (!sandbox.runId || !sandbox.previewURL) {
		throw new Error('Sandbox instance creation did not return a runId/previewURL');
	}

	const sandboxControlUrl = deriveControlUrl(sandbox.previewURL);
	const sandboxControlSecret = requireEnv('SANDBOX_CONTROLPLANE_SECRET');

	const harness: HarnessSessionStatus = await createHarnessSession(sessionId, description, sandboxControlUrl, sandboxControlSecret, fetchImpl);
	if (!harness.sessionId) {
		throw new Error('Harness session creation did not return a sessionId');
	}

	return {
		sandboxInstanceId: sandbox.runId,
		previewUrl: sandbox.previewURL,
		sandboxControlUrl,
		harnessSessionId: harness.sessionId,
		agentSessionId: harness.agentSessionId,
		phase: harness.phase,
		done: harness.done,
	};
}
