import { describe, expect, it } from 'vitest';
import { planMessage, type MessageDeps } from './messages';
import { newSessionState } from './state';

// MessageDeps isn't exercised by get_conversation_state (no mutate, no
// harness/LLM calls), so an all-throwing stub is enough to prove nothing
// unexpected is invoked.
const unusedDeps: MessageDeps = new Proxy({} as MessageDeps, {
	get() {
		throw new Error('unexpected dependency call');
	},
});

describe('get_conversation_state', () => {
	it('includes the session query, so the client can restore the "You" bubble without relying on agent_connected', async () => {
		// agent_connected is pushed from the WebSocket $connect route, which
		// AWS API Gateway cannot deliver to (connection isn't registered as
		// reachable until $connect returns) -- so query must also be
		// reachable via this $default-route response, which does work.
		const state = { ...newSessionState('sess-1', 'user-1', 3600), query: 'build me a todo app' };

		const plan = planMessage({ type: 'get_conversation_state' }, unusedDeps);
		const response = await plan.buildResponse(state);

		expect(response).toMatchObject({ type: 'conversation_state', state: { query: 'build me a todo app' } });
	});

	it('omits query as undefined when the session has none yet', async () => {
		const state = newSessionState('sess-1', 'user-1', 3600);

		const plan = planMessage({ type: 'get_conversation_state' }, unusedDeps);
		const response = await plan.buildResponse(state);

		expect(response).toMatchObject({ type: 'conversation_state', state: { query: '' } });
	});
});
