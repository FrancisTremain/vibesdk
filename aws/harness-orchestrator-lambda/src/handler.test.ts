import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { FakeEcsClient, FakeEc2Client } from './fake-ecs';
import { handler as rawHandler, setTestOverrides } from './handler';

async function handler(event: APIGatewayProxyEventV2 | { 'detail-type': string }): Promise<{ statusCode: number; body?: string }> {
	return (await rawHandler(event as APIGatewayProxyEventV2)) as { statusCode: number; body?: string };
}

const SECRET = 'harness-orchestrator-test-secret';
const CONTROLPLANE_SECRET = 'controlplane-test-secret';

beforeAll(() => {
	process.env.HARNESS_SESSIONS_TABLE = 'vibesdk-harness-sessions-test';
	process.env.ECS_CLUSTER = 'vibesdk-harness';
	process.env.ECS_TASK_DEFINITION_ARN = 'arn:aws:ecs:ap-southeast-2:111111111111:task-definition/vibesdk-harness:1';
	process.env.ECS_SUBNET_IDS = 'subnet-aaa,subnet-bbb';
	process.env.ECS_SECURITY_GROUP_ID = 'sg-123';
	process.env.CONTROLPLANE_SECRET = 'controlplane-test-secret';
	process.env.ORCHESTRATOR_SECRET = SECRET;
	process.env.IDLE_TIMEOUT_SECONDS = '600';
	process.env.AGENT_CONNECTIONS_TABLE = 'vibesdk-agent-connections-test';
	process.env.AGENT_CONNECTIONS_SESSION_INDEX = 'session_id-index';
	process.env.WS_MANAGEMENT_ENDPOINT = 'https://ws.test/prod';
	process.env.SANDBOX_ORCHESTRATOR_ENDPOINT = 'https://sandbox-orchestrator.test';
	process.env.SANDBOX_ORCHESTRATOR_SECRET = 'sandbox-orchestrator-test-secret';
});

function event(
	routeKey: string,
	opts: { pathParameters?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
	return {
		version: '2.0',
		routeKey,
		rawPath: '',
		rawQueryString: '',
		headers: { 'x-orchestrator-secret': SECRET, ...opts.headers },
		pathParameters: opts.pathParameters,
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

function putSession(item: Record<string, unknown>) {
	return fakeDdb.send(new PutCommand({ TableName: 'x', Item: { sandboxControlUrl: 'http://198.51.100.9:8080', sandboxControlSecret: 'sandbox-secret', createdAt: Date.now(), lastActivityAt: Date.now(), expiresAt: 0, ...item } }));
}

beforeEach(() => {
	wire();
});

describe('auth', () => {
	it('rejects calls without the orchestrator secret', async () => {
		const res = await handler(event('POST /api/harness/sessions', { headers: { 'x-orchestrator-secret': 'wrong' } }));
		expect(res.statusCode).toBe(403);
	});
});

describe('events relay', () => {
	it('rejects a pushed event without the correct controlplane secret', async () => {
		const res = await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-1' },
				headers: { 'x-controlplane-secret': 'wrong' },
				body: { type: 'phase_update', phase: { name: 'planning', status: 'started' } },
			}),
		);
		expect(res.statusCode).toBe(403);
	});

	it('relays a pushed event to the connections open for that session', async () => {
		const query = vi.fn().mockResolvedValue(['conn-1']);
		const send = vi.fn().mockResolvedValue({});
		setTestOverrides({ connectionsLookup: { query }, managementApi: { send } });

		const res = await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-1' },
				headers: { 'x-controlplane-secret': CONTROLPLANE_SECRET },
				body: { type: 'file_generated', filePath: 'src/App.tsx', fileContents: 'export default App;' },
			}),
		);

		expect(res.statusCode).toBe(200);
		expect(query).toHaveBeenCalledWith('session-1');
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('refreshes the session\'s own lastActivityAt/expiresAt when its status is RUNNING', async () => {
		const query = vi.fn().mockResolvedValue([]);
		const send = vi.fn().mockResolvedValue({});
		setTestOverrides({ connectionsLookup: { query }, managementApi: { send } });
		await putSession({ sessionId: 'session-activity-1', status: 'RUNNING', lastActivityAt: 1, expiresAt: 1 });

		await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-activity-1' },
				headers: { 'x-controlplane-secret': CONTROLPLANE_SECRET },
				body: { type: 'terminal_output', output: 'building...', outputType: 'stdout', timestamp: Date.now() },
			}),
		);

		const record = (await fakeDdb.send(new GetCommand({ TableName: 'x', Key: { sessionId: 'session-activity-1' } }))) as {
			Item: { lastActivityAt: number; expiresAt: number };
		};
		expect(record.Item.lastActivityAt).toBeGreaterThan(1);
		expect(record.Item.expiresAt).toBeGreaterThan(1);
	});

	it('forwards the event as an activity touch to the underlying sandbox instance when one is recorded on the session', async () => {
		const query = vi.fn().mockResolvedValue([]);
		const send = vi.fn().mockResolvedValue({});
		const sandboxTouchFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		setTestOverrides({ connectionsLookup: { query }, managementApi: { send }, fetchImpl: sandboxTouchFetch });
		await putSession({ sessionId: 'session-activity-2', status: 'RUNNING', sandboxInstanceId: 'sandbox-inst-2' });

		await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-activity-2' },
				headers: { 'x-controlplane-secret': CONTROLPLANE_SECRET },
				body: { type: 'terminal_output', output: 'building...', outputType: 'stdout', timestamp: Date.now() },
			}),
		);

		expect(sandboxTouchFetch).toHaveBeenCalledWith(
			'https://sandbox-orchestrator.test/api/sandbox/instances/sandbox-inst-2/activity',
			expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-orchestrator-secret': 'sandbox-orchestrator-test-secret' }) }),
		);
	});

	it('does not touch the sandbox when the session has no sandboxInstanceId recorded', async () => {
		const query = vi.fn().mockResolvedValue([]);
		const send = vi.fn().mockResolvedValue({});
		const sandboxTouchFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		setTestOverrides({ connectionsLookup: { query }, managementApi: { send }, fetchImpl: sandboxTouchFetch });
		await putSession({ sessionId: 'session-activity-3', status: 'RUNNING' });

		await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-activity-3' },
				headers: { 'x-controlplane-secret': CONTROLPLANE_SECRET },
				body: { type: 'terminal_output', output: 'building...', outputType: 'stdout', timestamp: Date.now() },
			}),
		);

		expect(sandboxTouchFetch).not.toHaveBeenCalled();
	});

	it('rejects an event body without a type', async () => {
		const query = vi.fn().mockResolvedValue([]);
		const send = vi.fn();
		setTestOverrides({ connectionsLookup: { query }, managementApi: { send } });

		const res = await handler(
			event('POST /api/harness/sessions/{id}/events', {
				pathParameters: { id: 'session-1' },
				headers: { 'x-controlplane-secret': CONTROLPLANE_SECRET },
				body: { filePath: 'src/App.tsx' },
			}),
		);

		expect(res.statusCode).toBe(400);
	});
});

describe('createSession', () => {
	it('launches a task, waits for its public IP, and starts the Agent SDK session', async () => {
		wire({
			fetchResponses: {
				'POST /start': { status: 200, body: { agentSessionId: 'agent-1', done: false, phase: { name: 'planning', status: 'started' } } },
			},
		});

		const res = await handler(
			event('POST /api/harness/sessions', {
				body: { userPrompt: 'Build me a todo app', sandboxControlUrl: 'http://198.51.100.9:8080', sandboxControlSecret: 'sandbox-secret' },
			}),
		);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body!) as any;
		expect(body.success).toBe(true);
		expect(body.data.sessionId).toBeTruthy();
		expect(body.data.agentSessionId).toBe('agent-1');
		expect(fakeDdb.size).toBe(1);
	});

	it('stores the caller-supplied sandboxInstanceId on the session record for later activity forwarding', async () => {
		wire({
			fetchResponses: {
				'POST /start': { status: 200, body: { agentSessionId: 'agent-1', done: false, phase: { name: 'planning', status: 'started' } } },
			},
		});

		const res = await handler(
			event('POST /api/harness/sessions', {
				body: {
					sessionId: 'session-with-sandbox',
					userPrompt: 'Build me a todo app',
					sandboxControlUrl: 'http://198.51.100.9:8080',
					sandboxControlSecret: 'sandbox-secret',
					sandboxInstanceId: 'sandbox-inst-created',
				},
			}),
		);

		expect(res.statusCode).toBe(200);
		const record = (await fakeDdb.send(new GetCommand({ TableName: 'x', Key: { sessionId: 'session-with-sandbox' } }))) as {
			Item: { sandboxInstanceId?: string };
		};
		expect(record.Item.sandboxInstanceId).toBe('sandbox-inst-created');
	});

	it('returns 502 and leaves no usable record when RunTask fails', async () => {
		wire({ ecsOpts: { failRunTask: 'RESOURCE:MEMORY' } });

		const res = await handler(
			event('POST /api/harness/sessions', {
				body: { userPrompt: 'hi', sandboxControlUrl: 'http://198.51.100.9:8080', sandboxControlSecret: 'sandbox-secret' },
			}),
		);

		expect(res.statusCode).toBe(502);
	});

	it('requires userPrompt and sandbox connection info', async () => {
		const res = await handler(event('POST /api/harness/sessions', { body: { userPrompt: 'hi' } }));
		expect(res.statusCode).toBe(400);
	});

	it('rejects a duplicate sessionId', async () => {
		await putSession({ sessionId: 's1', status: 'RUNNING' });
		const res = await handler(
			event('POST /api/harness/sessions', {
				body: { sessionId: 's1', userPrompt: 'hi', sandboxControlUrl: 'http://198.51.100.9:8080', sandboxControlSecret: 'sandbox-secret' },
			}),
		);
		expect(res.statusCode).toBe(409);
	});
});

describe('sendMessage', () => {
	it('returns 404 for an unknown session', async () => {
		const res = await handler(event('POST /api/harness/sessions/{id}/messages', { pathParameters: { id: 'nope' }, body: { content: 'hi' } }));
		expect(res.statusCode).toBe(404);
	});

	it('proxies via streamInput to a RUNNING session without relaunching a task', async () => {
		wire({ fetchResponses: { 'POST /message': { status: 200, body: { accepted: true } } } });
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn' });

		const res = await handler(event('POST /api/harness/sessions/{id}/messages', { pathParameters: { id: 's1' }, body: { content: 'make the button blue' } }));
		expect(res.statusCode).toBe(200);
	});

	it('relaunches and resumes a torn-down (IDLE) session', async () => {
		wire({ fetchResponses: { 'POST /start': { status: 200, body: { agentSessionId: 'agent-1', done: false } } } });
		await putSession({ sessionId: 's1', status: 'IDLE', agentSessionId: 'agent-1' });

		const res = await handler(event('POST /api/harness/sessions/{id}/messages', { pathParameters: { id: 's1' }, body: { content: 'still there?' } }));
		expect(res.statusCode).toBe(200);
	});
});

describe('recordActivity', () => {
	it('resets the idle clock for a RUNNING session', async () => {
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn', lastActivityAt: 0 });
		const res = await handler(event('POST /api/harness/sessions/{id}/activity', { pathParameters: { id: 's1' } }));
		expect(res.statusCode).toBe(200);

		wire({ fetchResponses: { 'GET /status': { status: 200, body: { done: false } } } });
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn', lastActivityAt: Date.now() - 500_000 });
		await handler(event('POST /api/harness/sessions/{id}/activity', { pathParameters: { id: 's1' } }));
		const statusRes = await handler(event('GET /api/harness/sessions/{id}/status', { pathParameters: { id: 's1' } }));
		const body = JSON.parse(statusRes.body!) as any;
		expect(body.data.done).toBe(false);
	});

	it('does not resurrect an IDLE session', async () => {
		await putSession({ sessionId: 's1', status: 'IDLE' });
		const res = await handler(event('POST /api/harness/sessions/{id}/activity', { pathParameters: { id: 's1' } }));
		const body = JSON.parse(res.body!) as any;
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('IDLE');
	});
});

describe('getStatus', () => {
	it('returns 404 for an unknown session', async () => {
		const res = await handler(event('GET /api/harness/sessions/{id}/status', { pathParameters: { id: 'nope' } }));
		expect(res.statusCode).toBe(404);
	});

	it('reports IDLE status without calling the control plane', async () => {
		await putSession({ sessionId: 's1', status: 'IDLE' });
		const res = await handler(event('GET /api/harness/sessions/{id}/status', { pathParameters: { id: 's1' } }));
		const body = JSON.parse(res.body!) as any;
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('IDLE');
	});
});

describe('deleteSession', () => {
	it('stops the ECS task and removes the session record', async () => {
		wire({ fetchResponses: { 'POST /shutdown': { status: 200, body: { done: true } } } });
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn' });

		const res = await handler(event('DELETE /api/harness/sessions/{id}', { pathParameters: { id: 's1' } }));
		expect(res.statusCode).toBe(200);
		expect(fakeDdb.size).toBe(0);
	});
});

describe('idle sweep', () => {
	it('stops the task for a session past the idle threshold and marks it IDLE, keeping the resume id', async () => {
		wire({ fetchResponses: { 'POST /shutdown': { status: 200, body: { agentSessionId: 'agent-1', done: false } } } });
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn', lastActivityAt: Date.now() - 700_000 });

		await handler({ 'detail-type': 'vibesdk.harness.idle_sweep' });

		const res = await handler(event('GET /api/harness/sessions/{id}/status', { pathParameters: { id: 's1' } }));
		const body = JSON.parse(res.body!) as any;
		expect(body.data.status).toBe('IDLE');
	});

	it('leaves a recently active session running', async () => {
		wire({ fetchResponses: { 'GET /status': { status: 200, body: { done: false } } } });
		await putSession({ sessionId: 's1', status: 'RUNNING', publicIp: '203.0.113.5', taskArn: 'arn', lastActivityAt: Date.now() });

		await handler({ 'detail-type': 'vibesdk.harness.idle_sweep' });

		const res = await handler(event('GET /api/harness/sessions/{id}/status', { pathParameters: { id: 's1' } }));
		const body = JSON.parse(res.body!) as any;
		expect(body.data.done).toBe(false);
	});
});

describe('unknown route', () => {
	it('returns 404', async () => {
		const res = await handler(event('GET /api/harness/nope'));
		expect(res.statusCode).toBe(404);
	});
});
