import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let fakeAuthMode: 'platform_key' | 'byo_credentials' = 'platform_key';
// A single stable mock instance -- harness-generation.ts caches its
// HarnessCredentialsStore at module scope after the first call, so a
// fresh mock reassigned per-test would silently stop being the one the
// cached store actually holds. mockReset() (not reassignment) in
// beforeEach keeps this the same object identity across tests.
const getMock = vi.fn(async () => ({ authMode: fakeAuthMode, updatedAt: 0 }));

vi.mock('vibesdk-db-identity', () => ({
	HarnessCredentialsStore: class {
		get = getMock;
	},
}));

const createSandboxInstanceMock = vi.fn();
vi.mock('./sandbox-client', () => ({ createSandboxInstance: (...args: unknown[]) => createSandboxInstanceMock(...args) }));

const createHarnessSessionMock = vi.fn();
vi.mock('./harness-client', () => ({ createHarnessSession: (...args: unknown[]) => createHarnessSessionMock(...args) }));

const { startHarnessGeneration } = await import('./harness-generation');

beforeEach(() => {
	process.env.SANDBOX_CONTROLPLANE_SECRET = 'sandbox-secret';
	process.env.IDENTITY_TABLE = 'test-identity';
	fakeAuthMode = 'platform_key';
	getMock.mockClear().mockImplementation(async () => ({ authMode: fakeAuthMode, updatedAt: 0 }));
	createSandboxInstanceMock.mockReset().mockResolvedValue({ runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' });
	createHarnessSessionMock.mockReset().mockResolvedValue({ sessionId: 'sess-1', agentSessionId: 'agent-1', done: false });
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('startHarnessGeneration', () => {
	// Ordered deliberately: harness-generation.ts caches its
	// HarnessCredentialsStore at module scope after the first successful
	// construction, so this is the only test that can observe the
	// "IDENTITY_TABLE unset" path -- once any later test constructs the
	// store, deleting the env var no longer prevents reuse of the cached
	// instance.
	it('defaults to false without throwing when IDENTITY_TABLE is not configured', async () => {
		delete process.env.IDENTITY_TABLE;
		await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(createHarnessSessionMock).toHaveBeenCalledWith(
			'sess-1',
			'build me a todo app',
			'http://1.2.3.4:8080',
			'sandbox-secret',
			'user-1',
			false,
			fetch,
			'inst-1',
		);
	});

	it('passes useUserCredentials=false when the user is on the platform-key path', async () => {
		fakeAuthMode = 'platform_key';
		await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(createHarnessSessionMock).toHaveBeenCalledWith(
			'sess-1',
			'build me a todo app',
			'http://1.2.3.4:8080',
			'sandbox-secret',
			'user-1',
			false,
			fetch,
			'inst-1',
		);
	});

	it('passes useUserCredentials=true when the user has uploaded credentials', async () => {
		fakeAuthMode = 'byo_credentials';
		await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(createHarnessSessionMock).toHaveBeenCalledWith(
			'sess-1',
			'build me a todo app',
			'http://1.2.3.4:8080',
			'sandbox-secret',
			'user-1',
			true,
			fetch,
			'inst-1',
		);
	});

	it('defaults to false without throwing when the credentials lookup itself fails', async () => {
		getMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
		await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(createHarnessSessionMock).toHaveBeenCalledWith(
			'sess-1',
			'build me a todo app',
			'http://1.2.3.4:8080',
			'sandbox-secret',
			'user-1',
			false,
			fetch,
			'inst-1',
		);
	});

	it('reports coarse cold-start progress through onProgress as the sandbox and harness come up', async () => {
		// The only real-time visibility the frontend otherwise gets during
		// this call is silence -- createSandboxInstance and
		// createHarnessSession each block for however long their own ECS
		// RunTask+waitForPublicIp+boot takes (seen live: tens of seconds).
		// onProgress is how the caller (aws/agent-runtime's handler.ts)
		// turns that into "platform alert" pushes instead of the UI just
		// showing an unexplained "Thinking..." the whole time.
		const events: { stage: string; status: 'started' | 'completed' }[] = [];
		await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1', fetch, (stage, status) => {
			events.push({ stage, status });
		});

		expect(events).toEqual([
			{ stage: 'sandbox', status: 'started' },
			{ stage: 'sandbox', status: 'completed' },
			{ stage: 'harness', status: 'started' },
			{ stage: 'harness', status: 'completed' },
		]);
	});

	it('still reports the sandbox stage even when onProgress is not provided', async () => {
		await expect(startHarnessGeneration('build me a todo app', 'sess-1', 'user-1')).resolves.toBeDefined();
	});

	it('reports sandbox started but not completed when sandbox creation itself fails', async () => {
		createSandboxInstanceMock.mockReset().mockRejectedValue(new Error('ECS RunTask failed'));
		const events: { stage: string; status: 'started' | 'completed' }[] = [];

		await expect(
			startHarnessGeneration('build me a todo app', 'sess-1', 'user-1', fetch, (stage, status) => { events.push({ stage, status }); }),
		).rejects.toThrow('ECS RunTask failed');

		expect(events).toEqual([{ stage: 'sandbox', status: 'started' }]);
	});

	it('prefers the ALB-fronted externalPreviewURL for the browser-facing previewUrl, but still derives sandboxControlUrl from the raw previewURL', async () => {
		// The ALB (aws/infra/sandbox/alb.tf) only proxies the dev-server port,
		// not the control-plane one -- deriveControlUrl must keep using the
		// raw task IP even once previewUrl itself switches to the ALB hostname.
		createSandboxInstanceMock.mockReset().mockResolvedValue({
			runId: 'inst-1',
			previewURL: 'http://1.2.3.4:3000',
			externalPreviewURL: 'https://inst-1.preview.tremain.dev',
		});

		const result = await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(result.previewUrl).toBe('https://inst-1.preview.tremain.dev');
		expect(result.sandboxControlUrl).toBe('http://1.2.3.4:8080');
	});

	it('falls back to the raw previewURL when ALB registration failed (externalPreviewURL absent)', async () => {
		createSandboxInstanceMock.mockReset().mockResolvedValue({ runId: 'inst-1', previewURL: 'http://1.2.3.4:3000' });

		const result = await startHarnessGeneration('build me a todo app', 'sess-1', 'user-1');

		expect(result.previewUrl).toBe('http://1.2.3.4:3000');
	});

	it('surfaces the harness session error instead of returning as if generation started', async () => {
		// Same shape a real "no Anthropic credentials configured" session
		// reports: sessionId present (aws/agent-runtime/src/harness-client.ts
		// fills it in even on the fail-fast poll path), done:true, error set --
		// this must not be treated as a normal, if stalled, successful start.
		createHarnessSessionMock.mockReset().mockResolvedValue({
			sessionId: 'sess-1',
			done: true,
			error: 'No Anthropic credentials configured for this session -- set the platform ANTHROPIC_API_KEY or upload Claude Code credentials for this account.',
		});

		await expect(startHarnessGeneration('build me a todo app', 'sess-1', 'user-1')).rejects.toThrow(
			/no anthropic credentials/i,
		);
	});
});
