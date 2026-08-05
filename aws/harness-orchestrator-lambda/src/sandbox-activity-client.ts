/**
 * Forwards real harness activity (file writes, commands, phase updates --
 * anything pushed through POST /api/harness/sessions/{id}/events, see
 * ./handler.ts's receiveEvent) as the underlying sandbox instance's own
 * activity signal, so aws/sandbox-orchestrator-lambda's reaper.ts can
 * idle-sweep on genuine inactivity instead of a blind fixed-TTL clock.
 * Fire-and-forget by design (see touchSandboxActivity's caller) -- a
 * delivery failure here must never block relaying the actual event to the
 * browser, which is the real-time path users actually notice.
 */

function endpointAndSecret(): { endpoint: string; secret: string } | null {
	const endpoint = process.env.SANDBOX_ORCHESTRATOR_ENDPOINT;
	const secret = process.env.SANDBOX_ORCHESTRATOR_SECRET;
	if (!endpoint || !secret) return null;
	return { endpoint: endpoint.replace(/\/$/, ''), secret };
}

// Per-Lambda-instance, best-effort throttle -- a burst of file_generated/
// terminal_output events during active generation can fire many times a
// second; touching DynamoDB on every single one is wasted work for a
// signal that only needs minute-level precision (the reaper's own sweep
// interval is coarser than this anyway). Not shared across concurrent
// Lambda instances -- worst case under concurrency is a few extra writes,
// never a correctness problem, since the reaper reads real state either way.
const lastTouchedAt = new Map<string, number>();
const THROTTLE_MS = 30_000;

export async function touchSandboxActivity(sandboxInstanceId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
	const config = endpointAndSecret();
	if (!config) return;

	const now = Date.now();
	const last = lastTouchedAt.get(sandboxInstanceId) ?? 0;
	if (now - last < THROTTLE_MS) return;
	lastTouchedAt.set(sandboxInstanceId, now);

	try {
		await fetchImpl(`${config.endpoint}/api/sandbox/instances/${encodeURIComponent(sandboxInstanceId)}/activity`, {
			method: 'POST',
			headers: { 'x-orchestrator-secret': config.secret },
		});
	} catch {
		// Best-effort -- see module comment.
	}
}
