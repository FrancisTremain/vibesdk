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
		);
	});
});
