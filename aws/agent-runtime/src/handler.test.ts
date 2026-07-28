import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

process.env.AGENT_SESSIONS_TABLE = 'vibesdk-agent-sessions';
process.env.AGENT_CONNECTIONS_TABLE = 'vibesdk-agent-connections';

// ./llm.ts and ./generation.ts make real HTTP calls (vibesdk-llm-client,
// aws/sandbox-orchestrator-lambda) -- mocked here so these tests exercise
// handler.ts's/messages.ts's own logic (state mutation, error propagation)
// without real network dependencies. Both are tested against a fake fetch
// in their own packages / this package's generation.test.ts.
const generateAssistantReplyMock = vi.fn<(history: unknown[], message: string) => Promise<string>>();
vi.mock('./llm', () => ({ generateAssistantReply: (...args: [unknown[], string]) => generateAssistantReplyMock(...args) }));

const runGenerationMock = vi.fn<(description: string, sessionId: string) => Promise<import('./messages').GenerationResult>>();
vi.mock('./generation', () => ({ runGeneration: (...args: [string, string]) => runGenerationMock(...args) }));

const deployProjectMock = vi.fn<(files: unknown[], projectName: string, initCommand: string) => Promise<import('./messages').DeployResult>>();
vi.mock('./deploy', () => ({ deployProject: (...args: [unknown[], string, string]) => deployProjectMock(...args) }));

const captureScreenshotMock = vi.fn<
	(sessionId: string, url: string, viewport?: unknown, waitSeconds?: number) => Promise<import('./messages').CaptureResult>
>();
vi.mock('./browser-capture-client', () => ({
	captureScreenshot: (...args: [string, string, unknown, number]) => captureScreenshotMock(...args),
}));

const { handler } = await import('./handler');

function asStructured(result: APIGatewayProxyResultV2): APIGatewayProxyStructuredResultV2 {
	if (typeof result === 'string') throw new Error('Expected a structured result, got a bare string');
	return result;
}

async function callHandler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	return asStructured(await handler(event));
}

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

function wsEvent(overrides: Partial<APIGatewayProxyWebsocketEventV2> = {}): APIGatewayProxyWebsocketEventV2 {
	return {
		requestContext: {
			routeKey: '$default',
			connectionId: 'conn-1',
			domainName: 'abc123.execute-api.ap-southeast-2.amazonaws.com',
			stage: 'prod',
			apiId: 'abc123',
			eventType: 'MESSAGE',
			messageId: 'msg-1',
			requestId: 'req-1',
			requestTimeEpoch: Date.now(),
			connectedAt: Date.now(),
			extendedRequestId: 'ext-1',
			messageDirection: 'IN',
		} as APIGatewayProxyWebsocketEventV2['requestContext'],
		body: JSON.stringify({ type: 'get_conversation_state' }),
		isBase64Encoded: false,
		...overrides,
	} as APIGatewayProxyWebsocketEventV2;
}

function responsesSent(): Record<string, unknown>[] {
	return apigwMock
		.commandCalls(PostToConnectionCommand)
		.map((call) => JSON.parse(Buffer.from(call.args[0]!.input.Data as Uint8Array).toString()));
}

beforeEach(() => {
	ddbMock.reset();
	apigwMock.reset();
	apigwMock.on(PostToConnectionCommand).resolves({});
	generateAssistantReplyMock.mockReset();
	generateAssistantReplyMock.mockResolvedValue('a reply');
	runGenerationMock.mockReset();
	deployProjectMock.mockReset();
	captureScreenshotMock.mockReset();
});

describe('$connect', () => {
	it('rejects a connect with no sessionId', async () => {
		const result = await callHandler(
			wsEvent({ requestContext: { routeKey: '$connect', connectionId: 'conn-1' } as APIGatewayProxyWebsocketEventV2['requestContext'], queryStringParameters: undefined }),
		);
		expect(result.statusCode).toBe(400);
	});

	it('initializes a brand-new session, records the connection, and acks agent_connected', async () => {
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: undefined });
		ddbMock.on(PutCommand).resolves({});

		const result = await callHandler(
			wsEvent({
				requestContext: { routeKey: '$connect', connectionId: 'conn-1' } as APIGatewayProxyWebsocketEventV2['requestContext'],
				queryStringParameters: { sessionId: 'session-1', userId: 'user-1' },
			}),
		);

		expect(result.statusCode).toBe(200);
		const connectionPuts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-connections' });
		expect(connectionPuts).toHaveLength(1);
		expect(connectionPuts[0]!.args[0]!.input.Item).toMatchObject({ connection_id: 'conn-1', session_id: 'session-1' });

		const sessionPuts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(sessionPuts).toHaveLength(1);
		expect(sessionPuts[0]!.args[0]!.input.Item).toMatchObject({ session_id: 'session-1', user_id: 'user-1', lock_version: 0 });

		const [ack] = responsesSent();
		expect(ack).toMatchObject({ type: 'agent_connected', state: { sessionId: 'session-1' } });
	});

	it('does not overwrite an existing session on reconnect', async () => {
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({
			Item: { session_id: 'session-1', lock_version: 5, user_id: 'user-1', project_name: 'demo', query: '', should_be_generating: false, current_dev_state: 'IDLE', conversation_messages: [], pending_user_inputs: [], created_at: 'x', updated_at: 'x', expires_at: 9999999999 },
		});
		ddbMock.on(PutCommand).resolves({});

		await callHandler(
			wsEvent({
				requestContext: { routeKey: '$connect', connectionId: 'conn-1' } as APIGatewayProxyWebsocketEventV2['requestContext'],
				queryStringParameters: { sessionId: 'session-1' },
			}),
		);

		const sessionPuts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(sessionPuts).toHaveLength(0);
	});
});

describe('$disconnect', () => {
	it('removes the connection record', async () => {
		ddbMock.on(DeleteCommand).resolves({});
		const result = await callHandler(
			wsEvent({ requestContext: { routeKey: '$disconnect', connectionId: 'conn-1' } as APIGatewayProxyWebsocketEventV2['requestContext'] }),
		);
		expect(result.statusCode).toBe(200);
		expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0]!.input).toEqual({
			TableName: 'vibesdk-agent-connections',
			Key: { connection_id: 'conn-1' },
		});
	});
});

describe('$default', () => {
	it('returns 404 for an unknown connection', async () => {
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-connections' }).resolves({ Item: undefined });
		const result = await callHandler(wsEvent());
		expect(result.statusCode).toBe(404);
		expect(apigwMock.commandCalls(PostToConnectionCommand)).toHaveLength(0);
	});

	const baseSession = {
		session_id: 'session-1',
		lock_version: 2,
		user_id: 'user-1',
		project_name: '',
		query: '',
		should_be_generating: false,
		current_dev_state: 'IDLE' as const,
		conversation_messages: [],
		pending_user_inputs: [],
		generated_files: {},
		created_at: 'x',
		updated_at: 'x',
		expires_at: 9999999999,
	};

	function wireConnection() {
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-connections' }).resolves({ Item: { connection_id: 'conn-1', session_id: 'session-1' } });
	}

	it('calls the LLM and appends both turns to conversation history under the optimistic lock', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		ddbMock.on(PutCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({});
		generateAssistantReplyMock.mockResolvedValue('Sure, building that now.');

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'user_suggestion', message: 'build me a todo app' }) }));

		expect(generateAssistantReplyMock).toHaveBeenCalledWith([], 'build me a todo app', 'session-1', 'user-1');

		const puts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(puts).toHaveLength(1);
		expect(puts[0]!.args[0]!.input.Item).toMatchObject({
			lock_version: 3,
			pending_user_inputs: ['build me a todo app'],
			conversation_messages: [
				{ role: 'user', content: 'build me a todo app' },
				{ role: 'assistant', content: 'Sure, building that now.' },
			],
		});
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'conversation_response', message: 'Sure, building that now.' });
	});

	it('rejects a user_suggestion with no message and persists nothing', async () => {
		wireConnection();
		await callHandler(wsEvent({ body: JSON.stringify({ type: 'user_suggestion' }) }));
		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		expect(generateAssistantReplyMock).not.toHaveBeenCalled();
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('No message provided') });
	});

	it('responds with an error and persists nothing when the LLM call fails', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		generateAssistantReplyMock.mockRejectedValue(new Error('No API key configured for provider "anthropic"'));

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'user_suggestion', message: 'build me a todo app' }) }));

		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('No API key configured') });
	});

	it('reapplies the mutation fresh from the re-read state on a lock conflict', async () => {
		wireConnection();
		ddbMock
			.on(GetCommand, { TableName: 'vibesdk-agent-sessions' })
			.resolvesOnce({ Item: baseSession })
			.resolvesOnce({ Item: { ...baseSession, lock_version: 3, pending_user_inputs: ['already there'] } });
		ddbMock
			.on(PutCommand, { TableName: 'vibesdk-agent-sessions' })
			.rejectsOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
			.resolves({});

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'user_suggestion', message: 'second message' }) }));

		expect(generateAssistantReplyMock).toHaveBeenCalledTimes(2);

		const puts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(puts).toHaveLength(2);
		expect(puts[1]!.args[0]!.input.Item).toMatchObject({
			lock_version: 4,
			pending_user_inputs: ['already there', 'second message'],
		});
	});

	it('resets conversation state on clear_conversation', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({
			Item: { ...baseSession, conversation_messages: [{ role: 'user', content: 'hi', created_at: 'x' }], pending_user_inputs: ['hi'] },
		});
		ddbMock.on(PutCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({});

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'clear_conversation' }) }));

		const puts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(puts[0]!.args[0]!.input.Item).toMatchObject({ conversation_messages: [], pending_user_inputs: [] });
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'conversation_cleared' });
	});

	it('reads conversation state without persisting anything', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({
			Item: { ...baseSession, pending_user_inputs: ['queued'] },
		});

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'get_conversation_state' }) }));

		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'conversation_state', state: { pendingUserInputs: ['queued'] } });
	});

	it('runs generation from an explicit message and persists the result', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		ddbMock.on(PutCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({});
		runGenerationMock.mockResolvedValue({
			projectName: 'todo-app',
			initCommand: 'bun run dev',
			files: [{ filePath: 'index.html', fileContents: '<h1>todo</h1>' }],
			previewUrl: 'http://203.0.113.5:3000',
			sandboxInstanceId: 'inst-1',
		});

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'generate_all', message: 'build me a todo app' }) }));

		expect(runGenerationMock).toHaveBeenCalledWith('build me a todo app', 'session-1', 'user-1');
		const puts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(puts).toHaveLength(1);
		expect(puts[0]!.args[0]!.input.Item).toMatchObject({
			project_name: 'todo-app',
			generated_files: { 'index.html': '<h1>todo</h1>' },
			sandbox_instance_id: 'inst-1',
			preview_url: 'http://203.0.113.5:3000',
			current_dev_state: 'REVIEWING',
			should_be_generating: false,
		});
		const [response] = responsesSent();
		expect(response).toMatchObject({
			type: 'generation_complete',
			projectName: 'todo-app',
			previewUrl: 'http://203.0.113.5:3000',
			files: [{ filePath: 'index.html', fileContents: '<h1>todo</h1>' }],
		});
	});

	it('falls back to the last user conversation turn when generate_all has no message', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({
			Item: {
				...baseSession,
				conversation_messages: [
					{ role: 'user', content: 'build a calculator', created_at: 'x' },
					{ role: 'assistant', content: 'sure', created_at: 'x' },
				],
			},
		});
		ddbMock.on(PutCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({});
		runGenerationMock.mockResolvedValue({ projectName: 'calc', initCommand: 'bun run dev', files: [{ filePath: 'a.js', fileContents: '1' }] });

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'generate_all' }) }));

		expect(runGenerationMock).toHaveBeenCalledWith('build a calculator', 'session-1', 'user-1');
	});

	it('errors without persisting when generate_all has no description available', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'generate_all' }) }));

		expect(runGenerationMock).not.toHaveBeenCalled();
		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('No project description available') });
	});

	it('errors without persisting when generation fails', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		runGenerationMock.mockRejectedValue(new Error('Model did not return valid JSON: Unexpected token'));

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'generate_all', message: 'build me a todo app' }) }));

		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('did not return valid JSON') });
	});

	it('returns an error for an unknown message type', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		await callHandler(wsEvent({ body: JSON.stringify({ type: 'made_up_type' }) }));
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('Unknown message type') });
	});

	it('deploys the already-generated files as an independent instance', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({
			Item: { ...baseSession, project_name: 'todo-app', init_command: 'bun run dev', generated_files: { 'a.txt': 'x' } },
		});
		ddbMock.on(PutCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({});
		deployProjectMock.mockResolvedValue({ deployedUrl: 'http://9.9.9.9:3000', deploymentInstanceId: 'deploy-1' });

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'deploy' }) }));

		expect(deployProjectMock).toHaveBeenCalledWith([{ filePath: 'a.txt', fileContents: 'x' }], 'todo-app', 'bun run dev');
		const puts = ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' });
		expect(puts[0]!.args[0]!.input.Item).toMatchObject({ deployed_url: 'http://9.9.9.9:3000', deployment_instance_id: 'deploy-1' });
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'deployment_completed', deployedUrl: 'http://9.9.9.9:3000' });
	});

	it('errors without persisting when deploying with nothing generated yet', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'deploy' }) }));

		expect(deployProjectMock).not.toHaveBeenCalled();
		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('Nothing to deploy yet') });
	});

	it('captures a screenshot without mutating state', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		captureScreenshotMock.mockResolvedValue({ screenshotUrl: 'https://s3.example/x.png', consoleLogs: [{ type: 'error', text: 'boom', timestamp: 1 }] });

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'capture_screenshot', data: { url: 'http://1.2.3.4:3000' } }) }));

		expect(captureScreenshotMock).toHaveBeenCalledWith('session-1', 'http://1.2.3.4:3000', undefined, undefined);
		expect(ddbMock.commandCalls(PutCommand, { TableName: 'vibesdk-agent-sessions' })).toHaveLength(0);
		const [response] = responsesSent();
		expect(response).toMatchObject({
			type: 'screenshot_capture_success',
			screenshotUrl: 'https://s3.example/x.png',
			consoleLogs: [{ type: 'error', text: 'boom', timestamp: 1 }],
		});
	});

	it('rejects capture_screenshot with no url before calling the capture Lambda', async () => {
		wireConnection();
		await callHandler(wsEvent({ body: JSON.stringify({ type: 'capture_screenshot' }) }));
		expect(captureScreenshotMock).not.toHaveBeenCalled();
		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'error', error: expect.stringContaining('Missing url') });
	});

	it('returns a screenshot_capture_error response when the capture Lambda call fails', async () => {
		wireConnection();
		ddbMock.on(GetCommand, { TableName: 'vibesdk-agent-sessions' }).resolves({ Item: baseSession });
		captureScreenshotMock.mockRejectedValue(new Error('navigation timeout'));

		await callHandler(wsEvent({ body: JSON.stringify({ type: 'capture_screenshot', data: { url: 'http://1.2.3.4:3000' } }) }));

		const [response] = responsesSent();
		expect(response).toMatchObject({ type: 'screenshot_capture_error', error: 'navigation timeout' });
	});
});
