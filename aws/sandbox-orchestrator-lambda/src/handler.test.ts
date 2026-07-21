import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { FakeEcsClient, FakeEc2Client } from './fake-ecs';
import { handler as rawHandler, setTestOverrides } from './handler';

// handler()'s declared return type is the full APIGatewayProxyResultV2
// union (which includes a bare string, per API Gateway's simple-response
// shorthand) even though this handler only ever returns the
// statusCode/body object form -- narrow it once here for every test.
async function handler(event: APIGatewayProxyEventV2): Promise<{ statusCode: number; body?: string }> {
	return (await rawHandler(event)) as { statusCode: number; body?: string };
}

const SECRET = 'orchestrator-test-secret';

beforeAll(() => {
	process.env.SANDBOX_INSTANCES_TABLE = 'vibesdk-sandbox-instances-test';
	process.env.ECS_CLUSTER = 'vibesdk-sandbox';
	process.env.ECS_TASK_DEFINITION_ARN = 'arn:aws:ecs:ap-southeast-2:111111111111:task-definition/vibesdk-sandbox:1';
	process.env.ECS_SUBNET_IDS = 'subnet-aaa,subnet-bbb';
	process.env.ECS_SECURITY_GROUP_ID = 'sg-123';
	process.env.CONTROLPLANE_SECRET = 'controlplane-test-secret';
	process.env.ORCHESTRATOR_SECRET = SECRET;
});

function event(
	routeKey: string,
	opts: { pathParameters?: Record<string, string>; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey,
		rawPath: '',
		rawQueryString: '',
		headers: { 'x-orchestrator-secret': SECRET, ...opts.headers },
		pathParameters: opts.pathParameters,
		queryStringParameters: opts.query,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		isBase64Encoded: false,
		requestContext: {} as APIGatewayProxyEventV2['requestContext'],
	} as APIGatewayProxyEventV2;
}

function makeFakeFetch(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
	return (async (url: string | URL, init?: RequestInit) => {
		const u = new URL(url.toString());
		const key = `${init?.method ?? 'GET'} ${u.pathname}`;
		const match = responses[key];
		if (!match) throw new Error(`no fake control-plane response configured for ${key}`);
		return new Response(JSON.stringify(match.body), { status: match.status });
	}) as typeof fetch;
}

let fakeDdb: FakeDynamoDocumentClient;

function wire(opts: { ecsOpts?: ConstructorParameters<typeof FakeEcsClient>[0]; publicIp?: string; fetchResponses?: Record<string, { status: number; body: unknown }> } = {}) {
	fakeDdb = new FakeDynamoDocumentClient();
	setTestOverrides({
		ddb: fakeDdb as unknown as DynamoDBDocumentClient,
		ecs: new FakeEcsClient({ eniId: 'eni-123', ...opts.ecsOpts }),
		ec2: new FakeEc2Client(opts.publicIp ?? '203.0.113.5'),
		fetchImpl: makeFakeFetch(opts.fetchResponses ?? {}),
	});
}

beforeEach(() => {
	wire();
});

describe('auth', () => {
	it('rejects calls without the orchestrator secret', async () => {
		const res = await handler(event('GET /api/sandbox/instances', { headers: { 'x-orchestrator-secret': 'wrong' } }));
		expect(res.statusCode).toBe(403);
	});
});

describe('createInstance', () => {
	it('launches a task, waits for its public IP, and bootstraps it', async () => {
		wire({
			fetchResponses: {
				'POST /bootstrap': { status: 200, body: { success: true, processId: 'x', message: 'Bootstrap complete' } },
			},
		});

		const res = await handler(
			event('POST /api/sandbox/instances', {
				body: { files: [{ filePath: 'a.txt', fileContents: 'hi' }], projectName: 'demo-app' },
			}),
		);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body!) as any;
		expect(body.success).toBe(true);
		expect(body.data.previewURL).toBe('http://203.0.113.5:3000');
		expect(body.data.runId).toBeTruthy();
		expect(fakeDdb.size).toBe(1);
	});

	it('returns 502 and does not create a DynamoDB record when RunTask fails', async () => {
		wire({ ecsOpts: { failRunTask: 'RESOURCE:MEMORY' } });

		const res = await handler(event('POST /api/sandbox/instances', { body: { files: [], projectName: 'demo-app' } }));

		expect(res.statusCode).toBe(502);
		expect(fakeDdb.size).toBe(0);
	});

	it('requires a projectName', async () => {
		const res = await handler(event('POST /api/sandbox/instances', { body: { files: [] } }));
		expect(res.statusCode).toBe(400);
	});
});

describe('getInstanceStatus', () => {
	it('returns 404 for an unknown instance', async () => {
		const res = await handler(event('GET /api/sandbox/instances/{id}/status', { pathParameters: { id: 'nope' } }));
		expect(res.statusCode).toBe(404);
	});

	it('reports pending without calling the control plane while still provisioning', async () => {
		await fakeDdb.send(
			new (await import('@aws-sdk/lib-dynamodb')).PutCommand({
				TableName: 'x',
				Item: { instanceId: 'i1', taskArn: 'arn', status: 'PROVISIONING', projectName: 'p', createdAt: Date.now(), expiresAt: 0 },
			}),
		);

		const res = await handler(event('GET /api/sandbox/instances/{id}/status', { pathParameters: { id: 'i1' } }));
		const body = JSON.parse(res.body!) as any;
		expect(res.statusCode).toBe(200);
		expect(body.data.pending).toBe(true);
		expect(body.data.isHealthy).toBe(false);
	});
});

describe('proxy routes', () => {
	it('returns 409 when the instance is not yet running', async () => {
		await fakeDdb.send(
			new (await import('@aws-sdk/lib-dynamodb')).PutCommand({
				TableName: 'x',
				Item: { instanceId: 'i1', taskArn: 'arn', status: 'PROVISIONING', projectName: 'p', createdAt: Date.now(), expiresAt: 0 },
			}),
		);

		const res = await handler(event('GET /api/sandbox/instances/{id}/files', { pathParameters: { id: 'i1' } }));
		expect(res.statusCode).toBe(409);
	});

	it('proxies writeFiles to the control plane once running', async () => {
		wire({
			fetchResponses: {
				'POST /files': { status: 200, body: { success: true, results: [{ file: 'a.txt', success: true }] } },
			},
		});
		await fakeDdb.send(
			new (await import('@aws-sdk/lib-dynamodb')).PutCommand({
				TableName: 'x',
				Item: { instanceId: 'i1', taskArn: 'arn', publicIp: '203.0.113.5', status: 'RUNNING', projectName: 'p', createdAt: Date.now(), expiresAt: 0 },
			}),
		);

		const res = await handler(
			event('POST /api/sandbox/instances/{id}/files', {
				pathParameters: { id: 'i1' },
				body: { files: [{ filePath: 'a.txt', fileContents: 'hi' }] },
			}),
		);
		const body = JSON.parse(res.body!) as any;
		expect(res.statusCode).toBe(200);
		expect(body.data.results).toEqual([{ file: 'a.txt', success: true }]);
	});
});

describe('shutdownInstance', () => {
	it('stops the ECS task and removes the instance record', async () => {
		wire({ fetchResponses: { 'POST /shutdown': { status: 200, body: { success: true } } } });
		await fakeDdb.send(
			new (await import('@aws-sdk/lib-dynamodb')).PutCommand({
				TableName: 'x',
				Item: { instanceId: 'i1', taskArn: 'arn', publicIp: '203.0.113.5', status: 'RUNNING', projectName: 'p', createdAt: Date.now(), expiresAt: 0 },
			}),
		);

		const res = await handler(event('DELETE /api/sandbox/instances/{id}', { pathParameters: { id: 'i1' } }));
		expect(res.statusCode).toBe(200);
		expect(fakeDdb.size).toBe(0);
	});
});

describe('unknown route', () => {
	it('returns 404', async () => {
		const res = await handler(event('GET /api/sandbox/nope'));
		expect(res.statusCode).toBe(404);
	});
});
