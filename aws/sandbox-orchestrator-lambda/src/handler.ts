/**
 * API Gateway HTTP API (v2) Lambda implementing aws/sandbox-contract's
 * `SandboxServiceClient` (worker/services/sandbox/BaseSandboxService.ts's
 * abstract method surface) for the AWS sandbox. One Fargate task per
 * sandbox instance (aws/infra/sandbox), tracked in the
 * vibesdk-sandbox-instances DynamoDB table, each running
 * aws/sandbox-controlplane as its control-plane server.
 *
 * Not attached to the sandbox VPC (avoids ENI cold-start latency, per
 * aws/infra/sandbox/main.tf's security-group comment) -- calls out to
 * each task's control-plane port over the public internet instead,
 * authenticated with the shared X-Controlplane-Secret header. Callers
 * of *this* Lambda authenticate with a separate X-Orchestrator-Secret
 * header, same reasoning: this Lambda has no static egress IP either,
 * so its own caller (the not-yet-built code-generation orchestration
 * layer) can't be source-IP restricted, and gets the same
 * header-secret treatment instead.
 */

import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { EcsRunner } from './ecs-runner';
import { SandboxInstancesStore, newExpiresAt, type SandboxInstanceRecord } from './instances-store';
import { ControlPlaneClient } from './control-plane-client';
import { errorResponse, successResponse } from './response';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

const WORKSPACE_DIR = '/workspace/app';
const CONTROL_PORT = 8080;
const DEV_PORT = 3000;
const BOOTSTRAP_RETRY_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedDdb: DynamoDBDocumentClient | null = null;
let cachedEcs: Pick<ECSClient, 'send'> | null = null;
let cachedEc2: Pick<EC2Client, 'send'> | null = null;
let cachedStore: SandboxInstancesStore | null = null;
let cachedRunner: EcsRunner | null = null;
let fetchOverride: typeof fetch | null = null;

/** Test-only, mirrors the sibling Lambda packages' setDdbClientForTests. */
export function setTestOverrides(overrides: {
	ddb?: DynamoDBDocumentClient | null;
	ecs?: Pick<ECSClient, 'send'> | null;
	ec2?: Pick<EC2Client, 'send'> | null;
	fetchImpl?: typeof fetch | null;
}): void {
	if ('ddb' in overrides) cachedDdb = overrides.ddb ?? null;
	if ('ecs' in overrides) cachedEcs = overrides.ecs ?? null;
	if ('ec2' in overrides) cachedEc2 = overrides.ec2 ?? null;
	if ('fetchImpl' in overrides) fetchOverride = overrides.fetchImpl ?? null;
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

function getStore(): SandboxInstancesStore {
	if (cachedStore) return cachedStore;
	cachedStore = new SandboxInstancesStore(getDdb(), requireEnv('SANDBOX_INSTANCES_TABLE'));
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
		containerName: process.env.ECS_CONTAINER_NAME ?? 'sandbox',
	});
	return cachedRunner;
}

function controlPlaneFor(publicIp: string): ControlPlaneClient {
	return new ControlPlaneClient(`http://${publicIp}:${CONTROL_PORT}`, requireEnv('CONTROLPLANE_SECRET'), fetchOverride ?? fetch);
}

function toInstanceDetails(record: SandboxInstanceRecord, isHealthy?: boolean) {
	return {
		runId: record.instanceId,
		startTime: new Date(record.createdAt).toISOString(),
		uptime: (Date.now() - record.createdAt) / 1000,
		previewURL: record.publicIp ? `http://${record.publicIp}:${DEV_PORT}` : undefined,
		directory: WORKSPACE_DIR,
		serviceDirectory: WORKSPACE_DIR,
		processId: record.instanceId,
		...(isHealthy !== undefined ? { isHealthy } : {}),
	};
}

/** Rejects calls that don't carry the shared orchestrator secret --
 *  this Lambda has no static egress IP for its own caller to allowlist
 *  by source, so a header secret is the real authorization boundary
 *  (same pattern as aws/sandbox-controlplane's X-Controlplane-Secret). */
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

async function bootstrapWithRetry(cp: ControlPlaneClient, req: Parameters<ControlPlaneClient['bootstrap']>[0]) {
	let lastError: unknown;
	for (let attempt = 0; attempt < BOOTSTRAP_RETRY_ATTEMPTS; attempt++) {
		try {
			return await cp.bootstrap(req);
		} catch (err) {
			// Connection refused while the container's control-plane process
			// is still coming up right after the ECS task reports RUNNING.
			lastError = err;
			await sleep(BOOTSTRAP_RETRY_DELAY_MS);
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Bootstrap failed after retries');
}

async function createInstance(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const body = parseJsonBody(event) ?? {};
	const files = Array.isArray(body.files) ? (body.files as { filePath: string; fileContents: string }[]) : [];
	const projectName = typeof body.projectName === 'string' ? body.projectName : undefined;
	const envVars = typeof body.envVars === 'object' && body.envVars !== null ? (body.envVars as Record<string, string>) : undefined;
	const initCommand = typeof body.initCommand === 'string' ? body.initCommand : 'bun run dev';

	if (!projectName) return errorResponse('projectName is required', 400);

	const instanceId = randomUUID();
	const store = getStore();
	const runner = getRunner();

	let taskArn: string;
	try {
		taskArn = await runner.runTask(instanceId);
	} catch (err) {
		return errorResponse((err as Error).message, 502);
	}

	await store.put({
		instanceId,
		taskArn,
		status: 'PROVISIONING',
		projectName,
		createdAt: Date.now(),
		expiresAt: newExpiresAt(),
	});

	let publicIp: string;
	try {
		publicIp = await runner.waitForPublicIp(taskArn);
	} catch (err) {
		await store.update(instanceId, { status: 'ERROR', error: (err as Error).message });
		return errorResponse((err as Error).message, 502);
	}
	await store.update(instanceId, { publicIp, status: 'RUNNING' });

	try {
		const cp = controlPlaneFor(publicIp);
		const result = await bootstrapWithRetry(cp, { files, projectName, envVars, initCommand });
		if (result.status >= 400) {
			await store.update(instanceId, { status: 'ERROR', error: JSON.stringify(result.body) });
			return errorResponse('Sandbox bootstrap failed', 502);
		}
		return successResponse({
			...(result.body as Record<string, unknown>),
			runId: instanceId,
			previewURL: `http://${publicIp}:${DEV_PORT}`,
		});
	} catch (err) {
		await store.update(instanceId, { status: 'ERROR', error: (err as Error).message });
		return errorResponse((err as Error).message, 502);
	}
}

async function listAllInstances(): Promise<APIGatewayProxyResultV2> {
	const records = await getStore().listAll();
	const instances = records.map((r) => toInstanceDetails(r));
	return successResponse({ instances, count: instances.length });
}

async function getInstanceDetails(instanceId: string): Promise<APIGatewayProxyResultV2> {
	const record = await getStore().get(instanceId);
	if (!record) return errorResponse('Instance not found', 404);
	return successResponse({ instance: toInstanceDetails(record) });
}

async function getInstanceStatus(instanceId: string): Promise<APIGatewayProxyResultV2> {
	const record = await getStore().get(instanceId);
	if (!record) return errorResponse('Instance not found', 404);

	if (record.status !== 'RUNNING' || !record.publicIp) {
		return successResponse({
			pending: record.status === 'PROVISIONING',
			isHealthy: false,
			error: record.status === 'ERROR' ? record.error : undefined,
		});
	}

	const result = await controlPlaneFor(record.publicIp).status();
	return successResponse(result.body);
}

async function shutdownInstance(instanceId: string): Promise<APIGatewayProxyResultV2> {
	const record = await getStore().get(instanceId);
	if (!record) return errorResponse('Instance not found', 404);

	if (record.publicIp) {
		try {
			await controlPlaneFor(record.publicIp).shutdown();
		} catch {
			// Best-effort -- the task gets stopped below regardless.
		}
	}
	await getRunner().stopTask(record.taskArn);
	await getStore().delete(instanceId);
	return successResponse({ message: 'Instance shut down' });
}

/** Looks up an instance and fails clearly if its control-plane isn't reachable yet. */
async function getReadyInstance(instanceId: string): Promise<SandboxInstanceRecord | APIGatewayProxyResultV2> {
	const record = await getStore().get(instanceId);
	if (!record) return errorResponse('Instance not found', 404);
	if (record.status !== 'RUNNING' || !record.publicIp) return errorResponse('Instance is not ready', 409);
	return record;
}

function isErrorResponse(value: unknown): value is APIGatewayProxyResultV2 {
	return typeof value === 'object' && value !== null && 'statusCode' in value;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const authError = verifyCaller(event);
	if (authError) return authError;

	const routeKey = event.routeKey;
	const instanceId = event.pathParameters?.id;

	try {
		switch (routeKey) {
			case 'POST /api/sandbox/instances':
				return await createInstance(event);

			case 'GET /api/sandbox/instances':
				return await listAllInstances();

			case 'GET /api/sandbox/instances/{id}':
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				return await getInstanceDetails(instanceId);

			case 'GET /api/sandbox/instances/{id}/status':
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				return await getInstanceStatus(instanceId);

			case 'DELETE /api/sandbox/instances/{id}':
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				return await shutdownInstance(instanceId);

			case 'POST /api/sandbox/instances/{id}/files': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const body = parseJsonBody(event) ?? {};
				const result = await controlPlaneFor(record.publicIp!).writeFiles(
					body as { files: { filePath: string; fileContents: string }[]; commitMessage?: string },
				);
				return successResponse(result.body);
			}

			case 'GET /api/sandbox/instances/{id}/files': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const paths = event.queryStringParameters?.path?.split(',').map((p) => p.trim()).filter(Boolean);
				const result = await controlPlaneFor(record.publicIp!).getFiles(paths);
				return successResponse(result.body);
			}

			case 'POST /api/sandbox/instances/{id}/commands': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const body = parseJsonBody(event) ?? {};
				const result = await controlPlaneFor(record.publicIp!).executeCommands(
					body as { commands: string[]; timeout?: number },
				);
				return successResponse(result.body);
			}

			case 'GET /api/sandbox/instances/{id}/logs': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const onlyRecent = event.queryStringParameters?.onlyRecent === 'true';
				const durationSeconds = event.queryStringParameters?.durationSeconds
					? Number(event.queryStringParameters.durationSeconds)
					: undefined;
				const result = await controlPlaneFor(record.publicIp!).getLogs(onlyRecent, durationSeconds);
				return successResponse(result.body);
			}

			case 'GET /api/sandbox/instances/{id}/errors': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const clear = event.queryStringParameters?.clear === 'true';
				const result = await controlPlaneFor(record.publicIp!).getErrors(clear);
				return successResponse(result.body);
			}

			case 'POST /api/sandbox/instances/{id}/errors/clear': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const result = await controlPlaneFor(record.publicIp!).clearErrors();
				return successResponse(result.body);
			}

			case 'POST /api/sandbox/instances/{id}/analysis': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const body = parseJsonBody(event) ?? {};
				const lintFiles = Array.isArray(body.lintFiles) ? (body.lintFiles as string[]) : undefined;
				const result = await controlPlaneFor(record.publicIp!).runStaticAnalysis(lintFiles);
				return successResponse(result.body);
			}

			case 'POST /api/sandbox/instances/{id}/deploy': {
				if (!instanceId) return errorResponse('Instance ID is required', 400);
				const record = await getReadyInstance(instanceId);
				if (isErrorResponse(record)) return record;
				const result = await controlPlaneFor(record.publicIp!).deploy();
				return successResponse(result.body, result.status);
			}

			default:
				return errorResponse('Not found', 404);
		}
	} catch (err) {
		return errorResponse((err as Error).message ?? 'Internal server error', 500);
	}
}
