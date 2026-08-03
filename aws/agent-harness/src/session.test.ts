import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Fakes the whole SDK module: tools.ts's createSdkMcpServer/tool calls just
// need to not throw (their real behavior is covered directly in
// tools.test.ts against the real `tool()`); query() is faked to read the
// streaming-input prompt and emit a session_id immediately (so
// HarnessSession.start() resolves fast) followed by one 'result' per pushed
// message, mirroring how a real turn ends.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
	class FakeQuery {
		public closed = false;
		private readonly output: unknown[] = [];
		private readonly outputWaiters: (() => void)[] = [];
		private turnCount = 0;

		constructor(prompt: AsyncIterable<SDKUserMessage>) {
			void this.consumePrompt(prompt);
		}

		private async consumePrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
			for await (const _msg of prompt) {
				if (this.closed) break;
				this.turnCount++;
				this.emit({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
				this.emit({ type: 'result', subtype: 'success', session_id: 'fake-session-1', turn: this.turnCount });
			}
		}

		private emit(msg: unknown): void {
			this.output.push(msg);
			const waiter = this.outputWaiters.shift();
			if (waiter) waiter();
		}

		close(): void {
			this.closed = true;
		}

		async *[Symbol.asyncIterator]() {
			while (!this.closed || this.output.length > 0) {
				const next = this.output.shift();
				if (next) {
					yield next;
					continue;
				}
				if (this.closed) return;
				await new Promise<void>((resolve) => this.outputWaiters.push(resolve));
			}
		}
	}

	return {
		query: vi.fn((params: { prompt: AsyncIterable<SDKUserMessage> }) => new FakeQuery(params.prompt)),
		createSdkMcpServer: vi.fn((opts: unknown) => opts),
		tool: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, inputSchema: schema, handler })),
	};
});

const { HarnessSession } = await import('./session');

describe('HarnessSession', () => {
	it('start() resolves with the session id without waiting for the turn to finish', async () => {
		const session = new HarnessSession({ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret' });

		const status = await session.start('build me a todo app');

		expect(status.agentSessionId).toBe('fake-session-1');
	});

	it('reports done:true once the turn completes', async () => {
		const session = new HarnessSession({ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret' });
		await session.start('build me a todo app');

		await vi.waitFor(() => expect(session.getStatus().done).toBe(true));
	});

	it('sendMessage flips done back to false and a new result flips it back to true', async () => {
		const session = new HarnessSession({ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret' });
		await session.start('build me a todo app');
		await vi.waitFor(() => expect(session.getStatus().done).toBe(true));

		session.sendMessage('now add auth');
		expect(session.getStatus().done).toBe(false);

		await vi.waitFor(() => expect(session.getStatus().done).toBe(true));
	});

	it('shutdown closes the session and returns the final status', async () => {
		const session = new HarnessSession({ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret' });
		await session.start('build me a todo app');

		const status = await session.shutdown();
		expect(status.agentSessionId).toBe('fake-session-1');
	});
});

describe('HarnessSession auth.json branching path', () => {
	const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const originalApiKey = process.env.ANTHROPIC_API_KEY;

	afterEach(() => {
		if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
		if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalApiKey;
	});

	it('materializes credentials and unsets ANTHROPIC_API_KEY when useUserCredentials resolves a credential', async () => {
		process.env.ANTHROPIC_API_KEY = 'platform-key-should-be-removed';
		const fakeCredentialsClient = { getCredentialsJson: vi.fn().mockResolvedValue({ claudeAiOauth: { refreshToken: 'rt-1' } }) };

		const session = new HarnessSession(
			{ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret', userId: 'user-1', useUserCredentials: true },
			fakeCredentialsClient,
		);
		await session.start('build me a todo app');

		expect(fakeCredentialsClient.getCredentialsJson).toHaveBeenCalledWith('user-1');
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(process.env.CLAUDE_CONFIG_DIR).toBeDefined();

		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		const written = JSON.parse(await fs.readFile(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf-8'));
		expect(written).toEqual({ claudeAiOauth: { refreshToken: 'rt-1' } });
	});

	it('falls back to the platform key when useUserCredentials is set but nothing decrypts', async () => {
		process.env.ANTHROPIC_API_KEY = 'platform-key-stays';
		const fakeCredentialsClient = { getCredentialsJson: vi.fn().mockResolvedValue(null) };

		const session = new HarnessSession(
			{ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret', userId: 'user-1', useUserCredentials: true },
			fakeCredentialsClient,
		);
		await session.start('build me a todo app');

		expect(process.env.ANTHROPIC_API_KEY).toBe('platform-key-stays');
	});

	it('never touches credentials when useUserCredentials is not set', async () => {
		process.env.ANTHROPIC_API_KEY = 'platform-key-stays';
		const fakeCredentialsClient = { getCredentialsJson: vi.fn() };

		const session = new HarnessSession(
			{ sandboxControlUrl: 'http://sandbox.test', sandboxControlSecret: 'secret' },
			fakeCredentialsClient,
		);
		await session.start('build me a todo app');

		expect(fakeCredentialsClient.getCredentialsJson).not.toHaveBeenCalled();
		expect(process.env.ANTHROPIC_API_KEY).toBe('platform-key-stays');
	});
});
