/**
 * API Gateway HTTP API (v2) Lambda driving ECS RunTask/DescribeTasks/
 * StopTask against aws/infra/harness's Fargate cluster, one task per
 * chat session, tracked in the vibesdk-harness-sessions DynamoDB
 * table. Same "call out to a public IP, header-secret authenticated
 * both directions" shape as aws/sandbox-orchestrator-lambda -- see
 * that package's README for the full reasoning, which applies
 * identically here.
 *
 * Also handles the idle-timeout sweep: aws/infra/harness/orchestrator.tf's
 * EventBridge rule invokes this same Lambda directly (no routeKey,
 * `detail-type: "vibesdk.harness.idle_sweep"`) once a minute. The
 * sweep stops the task for any RUNNING session whose lastActivityAt is
 * older than IDLE_TIMEOUT_SECONDS, but keeps the DynamoDB row (status
 * IDLE) with the Agent SDK's own session id so a later message can
 * relaunch a task and resume the same conversation.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { EcsRunner } from './ecs-runner';
import { HarnessSessionsStore, newExpiresAt } from './sessions-store';
import { ControlPlaneClient, type HarnessStatus } from './control-plane-client';
import { DynamoDbConnectionsLookup, relayEvent, type ConnectionsLookup } from './event-relay';
import { errorResponse, successResponse } from './response';

interface IdleSweepEvent {
	'detail-type': 'vibesdk.harness.idle_sweep';
}

function isIdleSweepEvent(event: unknown): event is IdleSweepEvent {
	return typeof event === 'object' && event !== null && (event as Record<string, unknown>)['detail-type'] === 'vibesdk.harness.idle_sweep';
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

const CONTROL_PORT = 8081;
const START_RETRY_ATTEMPTS = 5;
const START_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedDdb: DynamoDBDocumentClient | null = null;
let cachedEcs: Pick<ECSClient, 'send'> | null = null;
let cachedEc2: Pick<EC2Client, 'send'> | null = null;
let cachedStore: HarnessSessionsStore | null = null;
let cachedRunner: EcsRunner | null = null;
let fetchOverride: typeof fetch | null = null;
let cachedConnectionsLookup: ConnectionsLookup | null = null;
let cachedManagementApi: Pick<ApiGatewayManagementApiClient, 'send'> | null = null;

/** Test-only, mirrors the sibling Lambda packages' setTestOverrides. */
export function setTestOverrides(overrides: {
	ddb?: DynamoDBDocumentClient | null;
	ecs?: Pick<ECSClient, 'send'> | null;
	ec2?: Pick<EC2Client, 'send'> | null;
	fetchImpl?: typeof fetch | null;
	connectionsLookup?: ConnectionsLookup | null;
	managementApi?: Pick<ApiGatewayManagementApiClient, 'send'> | null;
}): void {
	if ('ddb' in overrides) cachedDdb = overrides.ddb ?? null;
	if ('ecs' in overrides) cachedEcs = overrides.ecs ?? null;
	if ('ec2' in overrides) cachedEc2 = overrides.ec2 ?? null;
	if ('fetchImpl' in overrides) fetchOverride = overrides.fetchImpl ?? null;
	if ('connectionsLookup' in overrides) cachedConnectionsLookup = overrides.connectionsLookup ?? null;
	if ('managementApi' in overrides) cachedManagementApi = overrides.managementApi ?? null;
	cachedStore = null;
	cachedRunner = null;
}

function getDdb(): DynamoDBDocumentClient {
	return cachedDdb ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function getEcs(): Pick<ECSClient, 'send'> {
	return cachedEcs ?? new ECSClient({});
}

function getEc2(): Pick<EC2Client, 'send'> {
	return cachedEc2 ?? new EC2Client({});
}

function getStore(): HarnessSessionsStore {
	if (cachedStore) return cachedStore;
	cachedStore = new HarnessSessionsStore(getDdb(), requireEnv('HARNESS_SESSIONS_TABLE'));
	return cachedStore;
}

function getRunner(): EcsRunner {
	if (cachedRunner) return cachedRunner;
	cachedRunner = new EcsRunner({
		ecs: getEcs(),
		ec2: getEc2(),
		cluster: requireEnv('ECS_CLUSTER'),
		taskDefinitionArn: requireEnv('ECS_TASK_DEFINITION_ARN'),
		subnetIds: requireEnv('ECS_SUBNET_IDS').split(',').map((s) => s.trim()),
		securityGroupId: requireEnv('ECS_SECURITY_GROUP_ID'),
		containerName: process.env.ECS_CONTAINER_NAME ?? 'harness',
	});
	return cachedRunner;
}

function controlPlaneFor(publicIp: string): ControlPlaneClient {
	return new ControlPlaneClient(`http://${publicIp}:${CONTROL_PORT}`, requireEnv('CONTROLPLANE_SECRET'), fetchOverride ?? fetch);
}

function getConnectionsLookup(): ConnectionsLookup {
	if (cachedConnectionsLookup) return cachedConnectionsLookup;
	cachedConnectionsLookup = new DynamoDbConnectionsLookup(getDdb(), requireEnv('AGENT_CONNECTIONS_TABLE'), requireEnv('AGENT_CONNECTIONS_SESSION_INDEX'));
	return cachedConnectionsLookup;
}

function getManagementApi(): Pick<ApiGatewayManagementApiClient, 'send'> {
	if (cachedManagementApi) return cachedManagementApi;
	cachedManagementApi = new ApiGatewayManagementApiClient({ endpoint: requireEnv('WS_MANAGEMENT_ENDPOINT') });
	return cachedManagementApi;
}

/** Constant-time comparison against CONTROLPLANE_SECRET -- the caller here is a harness task pushing an event, not aws/agent-runtime (which authenticates with ORCHESTRATOR_SECRET via verifyCaller instead). Same secret this Lambda already sends as X-Controlplane-Secret when it calls a harness task's own control plane -- shared knowledge between exactly these two parties. */
function verifyHarnessCaller(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
	const secret = requireEnv('CONTROLPLANE_SECRET');
	const provided = event.headers?.['x-controlplane-secret'];
	if (typeof provided !== 'string' || provided.length !== secret.length) return errorResponse('Forbidden', 403);
	if (!timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) return errorResponse('Forbidden', 403);
	return null;
}

async function receiveEvent(sessionId: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const body = parseJsonBody(event);
	if (!body || typeof body.type !== 'string') return errorResponse('Event body must include a type', 400);

	await relayEvent(getConnectionsLookup(), getManagementApi(), sessionId, body);
	return successResponse({ relayed: true });
}

function idleTimeoutSeconds(): number {
	return Number(process.env.IDLE_TIMEOUT_SECONDS ?? 600);
}

function verifyCaller(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
	const secret = requireEnv('ORCHESTRATOR_SECRET');
	const provided = event.headers?.['x-orchestrator-secret'];
	if (provided !== secret) return errorResponse('Forbidden', 403);
	return null;
}

function parseJsonBody(event: APIGatewayProxyEventV2): Record<string, unknown> | null {
	if (!event.body) return null;
	try {
		const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function startWithRetry(cp: ControlPlaneClient, req: Parameters<ControlPlaneClient['start']>[0]) {
	let lastError: unknown;
	for (let attempt = 0; attempt < START_RETRY_ATTEMPTS; attempt++) {
		try {
			return await cp.start(req);
		} catch (err) {
			// Connection refused while the container's control-plane process
			// is still coming up right after the ECS task reports RUNNING.
			lastError = err;
			await sleep(START_RETRY_DELAY_MS);
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Start failed after retries');
}

/** Launches a task and starts (or resumes) the Agent SDK session on it. Shared by createSession and the IDLE branch of sendMessage. Returns the harness's status body on success, or an error response to return as-is. */
async function launchAndStart(
	sessionId: string,
	userPrompt: string,
	sandboxControlUrl: string,
	sandboxControlSecret: string,
	resumeAgentSessionId: string | undefined,
	userId: string | undefined,
	useUserCredentials: boolean | undefined,
): Promise<HarnessStatus | APIGatewayProxyResultV2> {
	const store = getStore();
	const runner = getRunner();

	let taskArn: string;
	try {
		taskArn = await runner.runTask(sessionId);
	} catch (err) {
		return errorResponse((err as Error).message, 502);
	}

	await store.update(sessionId, { taskArn, status: 'PROVISIONING', expiresAt: newExpiresAt() });

	let publicIp: string;
	try {
		publicIp = await runner.waitForPublicIp(taskArn);
	} catch (err) {
		await store.update(sessionId, { status: 'ERROR', error: (err as Error).message });
		return errorResponse((err as Error).message, 502);
	}

	try {
		const cp = controlPlaneFor(publicIp);
		const result = await startWithRetry(cp, {
			sessionId,
			userPrompt,
			sandboxControlUrl,
			sandboxControlSecret,
			resumeAgentSessionId,
			userId,
			useUserCredentials,
		});
		if (result.status >= 400) {
			await store.update(sessionId, { status: 'ERROR', error: JSON.stringify(result.body) });
			return errorResponse('Harness start failed', 502);
		}
		const now = Date.now();
		await store.update(sessionId, {
			publicIp,
			status: 'RUNNING',
			agentSessionId: result.body.agentSessionId,
			lastActivityAt: now,
			expiresAt: newExpiresAt(),
		});
		return result.body;
	} catch (err) {
		await store.update(sessionId, { status: 'ERROR', error: (err as Error).message });
		return errorResponse((err as Error).message, 502);
	}
}

async function createSession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const body = parseJsonBody(event) ?? {};
	const userPrompt = typeof body.userPrompt === 'string' ? body.userPrompt : undefined;
	const sandboxControlUrl = typeof body.sandboxControlUrl === 'string' ? body.sandboxControlUrl : undefined;
	const sandboxControlSecret = typeof body.sandboxControlSecret === 'string' ? body.sandboxControlSecret : undefined;
	const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : randomUUID();
	const userId = typeof body.userId === 'string' ? body.userId : undefined;
	const useUserCredentials = body.useUserCredentials === true;

	if (!userPrompt) return errorResponse('userPrompt is required', 400);
	if (!sandboxControlUrl || !sandboxControlSecret) return errorResponse('sandboxControlUrl and sandboxControlSecret are required', 400);

	const store = getStore();
	const existing = await store.get(sessionId);
	if (existing) return errorResponse('Session already exists', 409);

	const now = Date.now();
	await store.put({
		sessionId,
		status: 'PROVISIONING',
		sandboxControlUrl,
		sandboxControlSecret,
		userId,
		useUserCredentials,
		createdAt: now,
		lastActivityAt: now,
		expiresAt: newExpiresAt(),
	});

	const result = await launchAndStart(sessionId, userPrompt, sandboxControlUrl, sandboxControlSecret, undefined, userId, useUserCredentials);
	if (isErrorResponse(result)) return result;
	return successResponse({ sessionId, ...result });
}

async function sendMessage(sessionId: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const body = parseJsonBody(event) ?? {};
	const content = typeof body.content === 'string' ? body.content : undefined;
	if (!content) return errorResponse('content is required', 400);

	const store = getStore();
	const record = await store.get(sessionId);
	if (!record) return errorResponse('Session not found', 404);

	if (record.status === 'PROVISIONING') return errorResponse('Session is still starting', 409);

	if (record.status === 'RUNNING' && record.publicIp) {
		const cp = controlPlaneFor(record.publicIp);
		const result = await cp.sendMessage(content);
		await store.update(sessionId, { lastActivityAt: Date.now(), expiresAt: newExpiresAt() });
		return successResponse(result.body);
	}

	// IDLE (or ERROR -- worth a fresh attempt) -- resume on a freshly launched task.
	const result = await launchAndStart(
		sessionId,
		content,
		record.sandboxControlUrl,
		record.sandboxControlSecret,
		record.agentSessionId,
		record.userId,
		record.useUserCredentials,
	);
	if (isErrorResponse(result)) return result;
	return successResponse(result);
}

async function recordActivity(sessionId: string): Promise<APIGatewayProxyResultV2> {
	const store = getStore();
	const record = await store.get(sessionId);
	if (!record) return errorResponse('Session not found', 404);

	// UI activity alone never resurrects an already-torn-down session --
	// only an explicit message does (see sendMessage's IDLE branch). This
	// only resets the sliding idle clock for a session whose task is
	// still up.
	if (record.status === 'RUNNING') {
		await store.update(sessionId, { lastActivityAt: Date.now(), expiresAt: newExpiresAt() });
	}
	return successResponse({ status: record.status });
}

async function getStatus(sessionId: string): Promise<APIGatewayProxyResultV2> {
	const store = getStore();
	const record = await store.get(sessionId);
	if (!record) return errorResponse('Session not found', 404);

	if (record.status !== 'RUNNING' || !record.publicIp) {
		return successResponse({ status: record.status, error: record.status === 'ERROR' ? record.error : undefined });
	}

	const result = await controlPlaneFor(record.publicIp).status();
	return successResponse(result.body);
}

async function deleteSession(sessionId: string): Promise<APIGatewayProxyResultV2> {
	const store = getStore();
	const record = await store.get(sessionId);
	if (!record) return errorResponse('Session not found', 404);

	if (record.status === 'RUNNING' && record.publicIp && record.taskArn) {
		try {
			await controlPlaneFor(record.publicIp).shutdown();
		} catch {
			// Best-effort -- the task gets stopped below regardless.
		}
		await getRunner().stopTask(record.taskArn);
	}
	await store.delete(sessionId);
	return successResponse({ message: 'Session closed' });
}

/** Stops the task for any RUNNING session idle past the threshold, keeping the row (status IDLE) for later resume. */
async function idleSweep(): Promise<void> {
	const store = getStore();
	const runner = getRunner();
	const threshold = Date.now() - idleTimeoutSeconds() * 1000;
	const records = await store.listAll();

	for (const record of records) {
		if (record.status !== 'RUNNING' || record.lastActivityAt >= threshold) continue;

		let agentSessionId = record.agentSessionId;
		if (record.publicIp) {
			try {
				const result = await controlPlaneFor(record.publicIp).shutdown();
				const reported = (result.body as { agentSessionId?: string }).agentSessionId;
				if (reported) agentSessionId = reported;
			} catch {
				// Best-effort -- proceed to stop the task regardless.
			}
		}
		if (record.taskArn) {
			try {
				await runner.stopTask(record.taskArn);
			} catch {
				// Task may already be gone; the row still needs to move to IDLE.
			}
		}
		await store.update(record.sessionId, {
			status: 'IDLE',
			taskArn: undefined,
			publicIp: undefined,
			agentSessionId,
			expiresAt: newExpiresAt(),
		});
	}
}

function isErrorResponse(value: unknown): value is APIGatewayProxyResultV2 {
	return typeof value === 'object' && value !== null && 'statusCode' in value && (value as { statusCode: number }).statusCode >= 400;
}

export async function handler(event: APIGatewayProxyEventV2 | IdleSweepEvent): Promise<APIGatewayProxyResultV2 | void> {
	if (isIdleSweepEvent(event)) {
		await idleSweep();
		return;
	}

	const routeKey = event.routeKey;
	const sessionId = event.pathParameters?.id;

	// Authenticated separately from every other route here -- the caller
	// is a harness task pushing its own event, not aws/agent-runtime.
	if (routeKey === 'POST /api/harness/sessions/{id}/events') {
		const authError = verifyHarnessCaller(event);
		if (authError) return authError;
		if (!sessionId) return errorResponse('Session ID is required', 400);
		try {
			return await receiveEvent(sessionId, event);
		} catch (err) {
			return errorResponse((err as Error).message ?? 'Internal server error', 500);
		}
	}

	const authError = verifyCaller(event);
	if (authError) return authError;

	try {
		switch (routeKey) {
			case 'POST /api/harness/sessions':
				return await createSession(event);

			case 'GET /api/harness/sessions/{id}/status':
				if (!sessionId) return errorResponse('Session ID is required', 400);
				return await getStatus(sessionId);

			case 'POST /api/harness/sessions/{id}/messages':
				if (!sessionId) return errorResponse('Session ID is required', 400);
				return await sendMessage(sessionId, event);

			case 'POST /api/harness/sessions/{id}/activity':
				if (!sessionId) return errorResponse('Session ID is required', 400);
				return await recordActivity(sessionId);

			case 'DELETE /api/harness/sessions/{id}':
				if (!sessionId) return errorResponse('Session ID is required', 400);
				return await deleteSession(sessionId);

			default:
				return errorResponse('Not found', 404);
		}
	} catch (err) {
		return errorResponse((err as Error).message ?? 'Internal server error', 500);
	}
}
