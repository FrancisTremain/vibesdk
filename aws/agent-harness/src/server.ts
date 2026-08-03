/**
 * Control-plane HTTP server for the harness Fargate task (runs as the
 * container's entrypoint process) -- implements the /start /message
 * /status /shutdown contract aws/harness-orchestrator-lambda/src/control-plane-client.ts
 * expects. Same plain node:http + shared-secret-header shape as
 * aws/sandbox-controlplane/src/server.ts.
 *
 * One HarnessSession per container (one Fargate task per chat session,
 * per aws/infra/harness's design) -- created on the first /start call
 * and reused for every subsequent /message, so streaming-input mode's
 * whole point (no restart between turns) actually holds.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { HarnessSession, type HarnessStatus } from './session';

const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? '8081');

function isAuthorized(req: IncomingMessage): boolean {
	const secret = process.env.CONTROLPLANE_SECRET;
	if (!secret) return true; // test/dev mode, no secret configured
	const provided = req.headers['x-controlplane-secret'];
	if (typeof provided !== 'string' || provided.length !== secret.length) return false;
	return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf-8');
	return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
	res.end(payload);
}

let session: HarnessSession | undefined;

async function handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = {
		sessionId?: string;
		userPrompt: string;
		sandboxControlUrl: string;
		sandboxControlSecret: string;
		resumeAgentSessionId?: string;
		userId?: string;
		useUserCredentials?: boolean;
	};
	const body = await readJsonBody<Body>(req);

	if (!body.userPrompt || !body.sandboxControlUrl || !body.sandboxControlSecret) {
		sendJson(res, 400, { success: false, error: 'userPrompt, sandboxControlUrl, and sandboxControlSecret are required' });
		return;
	}
	if (session) {
		sendJson(res, 409, { success: false, error: 'Session already started on this task' });
		return;
	}

	session = new HarnessSession({
		sandboxControlUrl: body.sandboxControlUrl,
		sandboxControlSecret: body.sandboxControlSecret,
		resumeAgentSessionId: body.resumeAgentSessionId,
		userId: body.userId,
		useUserCredentials: body.useUserCredentials,
	});

	try {
		const status = await session.start(body.userPrompt);
		sendJson(res, 200, status);
	} catch (err) {
		sendJson(res, 502, { success: false, error: (err as Error).message });
	}
}

async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
	type Body = { content: string };
	const body = await readJsonBody<Body>(req);

	if (!session) {
		sendJson(res, 409, { success: false, error: 'No session started on this task yet' });
		return;
	}
	if (!body.content) {
		sendJson(res, 400, { success: false, error: 'content is required' });
		return;
	}

	session.sendMessage(body.content);
	sendJson(res, 200, session.getStatus());
}

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
	const status: HarnessStatus = session?.getStatus() ?? { done: true };
	sendJson(res, 200, status);
}

async function handleShutdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	const status = session ? await session.shutdown() : { done: true };
	sendJson(res, 200, status);
	// Exit shortly after responding so the orchestrator's HTTP call completes first -- same pattern as aws/sandbox-controlplane's handleShutdown.
	setTimeout(() => process.exit(0), 250);
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void> = {
	'POST /start': handleStart,
	'POST /message': handleMessage,
	'GET /status': handleStatus,
	'POST /shutdown': handleShutdown,
};

export function createControlPlaneServer() {
	return createServer((req, res) => {
		if (!isAuthorized(req)) {
			sendJson(res, 403, { success: false, error: 'Forbidden' });
			return;
		}
		const url = new URL(req.url ?? '', 'http://localhost');
		const key = `${req.method} ${url.pathname}`;
		const route = routes[key];
		if (!route) {
			sendJson(res, 404, { success: false, error: 'Not found' });
			return;
		}
		Promise.resolve(route(req, res)).catch((err) => {
			sendJson(res, 500, { success: false, error: (err as Error).message });
		});
	});
}

/* c8 ignore start -- entrypoint, exercised via the Dockerfile CMD, not unit tests */
if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
	createControlPlaneServer().listen(CONTROL_PORT, () => {
		console.log(`agent-harness control plane listening on :${CONTROL_PORT}`);
	});
}
/* c8 ignore stop */
