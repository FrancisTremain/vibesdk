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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HarnessCredentialsStore } from 'vibesdk-db-identity';
import { createSandboxInstance } from './sandbox-client';
import { createHarnessSession, type HarnessSessionStatus } from './harness-client';

let cachedCredentialsStore: HarnessCredentialsStore | null = null;

/** Whether this user is on the auth.json branching path -- see aws/agent-harness/src/credentials-client.ts. Defaults to the platform key (false) on any lookup failure; an auth-mode read should never block generation from starting. */
async function shouldUseUserCredentials(userId: string): Promise<boolean> {
	try {
		if (!cachedCredentialsStore) {
			const tableName = process.env.IDENTITY_TABLE;
			if (!tableName) return false;
			const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
			// Cast at the package boundary -- see ./usage.ts's identical comment.
			cachedCredentialsStore = new HarnessCredentialsStore(ddb as unknown as ConstructorParameters<typeof HarnessCredentialsStore>[0], tableName);
		}
		const record = await cachedCredentialsStore.get(userId);
		return record.authMode === 'byo_credentials';
	} catch (err) {
		console.error('Failed to read harness auth mode, defaulting to platform key', err);
		return false;
	}
}

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

/** Coarse cold-start stage reporting -- the only real-time visibility available while createSandboxInstance/createHarnessSession are each blocked for however long their own ECS RunTask+waitForPublicIp+boot takes (seen live: tens of seconds of otherwise-silent "Thinking..."). aws/agent-runtime's handler.ts turns these into platform-level WebSocket pushes, not chat messages -- see its infra_status handling. */
export type HarnessGenerationProgress = (stage: 'sandbox' | 'harness', status: 'started' | 'completed') => void | Promise<void>;

export async function startHarnessGeneration(
	description: string,
	sessionId: string,
	userId: string,
	fetchImpl: typeof fetch = fetch,
	onProgress?: HarnessGenerationProgress,
): Promise<HarnessGenerationStart> {
	await onProgress?.('sandbox', 'started');
	const sandbox = await createSandboxInstance([], 'generated-app', 'true', fetchImpl);
	if (!sandbox.runId || !sandbox.previewURL) {
		throw new Error('Sandbox instance creation did not return a runId/previewURL');
	}
	await onProgress?.('sandbox', 'completed');

	const sandboxControlUrl = deriveControlUrl(sandbox.previewURL);
	const sandboxControlSecret = requireEnv('SANDBOX_CONTROLPLANE_SECRET');
	const useUserCredentials = await shouldUseUserCredentials(userId);

	await onProgress?.('harness', 'started');
	const harness: HarnessSessionStatus = await createHarnessSession(
		sessionId,
		description,
		sandboxControlUrl,
		sandboxControlSecret,
		userId,
		useUserCredentials,
		fetchImpl,
		sandbox.runId,
	);
	if (!harness.sessionId) {
		throw new Error('Harness session creation did not return a sessionId');
	}
	if (harness.error) {
		throw new Error(harness.error);
	}
	await onProgress?.('harness', 'completed');

	return {
		sandboxInstanceId: sandbox.runId,
		// Browser-facing URL prefers the ALB-fronted HTTPS hostname
		// (sandbox.externalPreviewURL) -- the raw http://<ip>:3000 in
		// sandbox.previewURL can never load inside the app at all (mixed
		// content: an HTTPS page can't fetch/embed HTTP, confirmed live), and
		// falls back to it only if ALB registration itself failed. Note
		// sandboxControlUrl above is deliberately derived from the raw
		// previewURL, not this -- the ALB only proxies port 3000.
		previewUrl: sandbox.externalPreviewURL ?? sandbox.previewURL,
		sandboxControlUrl,
		harnessSessionId: harness.sessionId,
		agentSessionId: harness.agentSessionId,
		phase: harness.phase,
		done: harness.done,
	};
}
