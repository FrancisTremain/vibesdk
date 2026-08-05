import { describe, expect, it, vi } from 'vitest';
import type { WebSocketMessage } from '@/api-types';
import type { HandleMessageDeps } from './handle-websocket-message';
import type { ChatMessage } from './message-helpers';

// sonner's toast internals reach for requestAnimationFrame, which doesn't
// exist in the Workers-pool test runtime (no DOM) -- not under test here,
// only that the handler calls toast.error/info for the cases that still use it.
vi.mock('sonner', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }));

const { createWebSocketMessageHandler } = await import('./handle-websocket-message');

// Minimal stand-in for every dispatcher/callback the handler can touch --
// only setIsThinking/setIsGenerating/setMessages are asserted on below,
// the rest exist purely so the handler doesn't crash on an undefined call.
function buildDeps(overrides: Partial<HandleMessageDeps> = {}): HandleMessageDeps {
	return {
		setFiles: vi.fn(),
		setPhaseTimeline: vi.fn(),
		setProjectStages: vi.fn(),
		setMessages: vi.fn(),
		setBlueprint: vi.fn(),
		setQuery: vi.fn(),
		setPreviewUrl: vi.fn(),
		setTotalFiles: vi.fn(),
		setIsRedeployReady: vi.fn(),
		setIsPreviewDeploying: vi.fn(),
		setIsThinking: vi.fn(),
		setIsInitialStateRestored: vi.fn(),
		setShouldRefreshPreview: vi.fn(),
		setIsDeploying: vi.fn(),
		setCloudflareDeploymentUrl: vi.fn(),
		setDeploymentError: vi.fn(),
		setIsGenerationPaused: vi.fn(),
		setIsGenerating: vi.fn(),
		setIsPhaseProgressActive: vi.fn(),
		setRuntimeErrorCount: vi.fn(),
		setStaticIssueCount: vi.fn(),
		setIsDebugging: vi.fn(),
		setBehaviorType: vi.fn(),
		setInternalProjectType: vi.fn(),
		setTemplateDetails: vi.fn(),
		setBackendErrorDialog: vi.fn(),
		isInitialStateRestored: true,
		blueprint: undefined,
		query: 'build me a todo app',
		bootstrapFiles: [],
		files: [],
		phaseTimeline: [],
		previewUrl: undefined,
		projectStages: [],
		isGenerating: true,
		urlChatId: 'session-1',
		behaviorType: 'phasic',
		updateStage: vi.fn(),
		sendMessage: vi.fn(),
		loadBootstrapFiles: vi.fn(),
		...overrides,
	} as HandleMessageDeps;
}

describe('createWebSocketMessageHandler', () => {
	it('clears isThinking and isGenerating when an error message arrives, so "Thinking..." does not stick around next to the real error', () => {
		// Caught live: generate_all's cold start can outrun API Gateway's
		// WebSocket route's 29s integration wait, and once the real error
		// ("No Anthropic credentials configured...") finally lands, the
		// "Thinking..." bubble stayed forever alongside it -- every other
		// terminal case (phase_update, generation_complete, ...) clears
		// these flags, this one didn't.
		const deps = buildDeps();
		const handle = createWebSocketMessageHandler(deps);

		const errorMessage = { type: 'error', error: 'No Anthropic credentials configured for this session.' } as WebSocketMessage;
		handle({} as never, errorMessage);

		expect(deps.setIsThinking).toHaveBeenCalledWith(false);
		expect(deps.setIsGenerating).toHaveBeenCalledWith(false);
	});

	it('drops the stale "main" Thinking placeholder when an error arrives, instead of leaving it stuck next to the real error', () => {
		// use-chat.ts seeds messages with a literal { conversationId: 'main',
		// content: 'Thinking...', ui: { isThinking: true } } placeholder when
		// a new chat opens. setIsThinking(false) only resets the unrelated
		// global boolean flag (phase-timeline animation) -- it never touches
		// this placeholder message, which is why it stayed visible forever
		// right above the real "No Anthropic credentials configured" error
		// bubble (caught live, even after the setIsThinking fix landed).
		let messages: ChatMessage[] = [
			{ role: 'assistant', conversationId: 'main', content: 'Thinking...', ui: { isThinking: true } },
		];
		const setMessages = vi.fn((updater: React.SetStateAction<ChatMessage[]>) => {
			messages = typeof updater === 'function' ? updater(messages) : updater;
		});
		const deps = buildDeps({ setMessages });
		const handle = createWebSocketMessageHandler(deps);

		const errorMessage = { type: 'error', error: 'No Anthropic credentials configured for this session.' } as WebSocketMessage;
		handle({} as never, errorMessage);

		expect(messages.some(m => m.conversationId === 'main' && m.ui?.isThinking)).toBe(false);
		expect(messages.some(m => m.content.includes('No Anthropic credentials configured'))).toBe(true);
	});

	it('updates the inline "main" placeholder with cold-start progress instead of a toast when infra_status starts', () => {
		// Previously this only fired a sonner toast, a second, separate
		// "what's happening" indicator sitting alongside a "Thinking..."
		// bubble that never actually said anything relevant during the
		// AWS-only ECS cold start.
		const deps = buildDeps();
		const handle = createWebSocketMessageHandler(deps);

		handle({} as never, { type: 'infra_status', stage: 'sandbox', status: 'started' } as WebSocketMessage);

		expect(deps.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: 'main', content: 'Setting up preview environment...' }),
		);
		expect(deps.setIsThinking).toHaveBeenCalledWith(true);
	});

	it('uses the harness-specific label for infra_status stage "harness"', () => {
		const deps = buildDeps();
		const handle = createWebSocketMessageHandler(deps);

		handle({} as never, { type: 'infra_status', stage: 'harness', status: 'started' } as WebSocketMessage);

		expect(deps.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: 'main', content: 'Starting build environment...' }),
		);
	});

	it('reverts the "main" placeholder back to the generic "Thinking..." once infra_status completes', () => {
		const deps = buildDeps();
		const handle = createWebSocketMessageHandler(deps);

		handle({} as never, { type: 'infra_status', stage: 'sandbox', status: 'completed' } as WebSocketMessage);

		expect(deps.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: 'main', content: 'Thinking...' }),
		);
	});

	it('does not throw on a non-app WebSocket frame (e.g. API Gateway\'s own timeout system message)', () => {
		// API Gateway pushes `{"message":"Endpoint request timed out",
		// "connectionId":"...","requestId":"..."}` directly to the client
		// when a Lambda invocation outruns the route's 29s integration
		// wait -- this has no `type` field at all. The handler used to
		// read `message.type.length` unconditionally and crash with
		// "Cannot read properties of undefined (reading 'length')",
		// caught live in the console right before the stuck-Thinking bug.
		const deps = buildDeps();
		const handle = createWebSocketMessageHandler(deps);

		const gatewayTimeoutFrame = {
			message: 'Endpoint request timed out',
			connectionId: 'abc',
			requestId: 'def',
		} as unknown as WebSocketMessage;

		expect(() => handle({} as never, gatewayTimeoutFrame)).not.toThrow();
		expect(deps.setMessages).not.toHaveBeenCalled();
	});
});
