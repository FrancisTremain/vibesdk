import { describe, it, expect, vi } from 'vitest';
import { relayEvent, type ConnectionsLookup } from './event-relay';

function fakeConnections(connectionIds: string[]): ConnectionsLookup {
	return { query: vi.fn().mockResolvedValue(connectionIds) };
}

describe('relayEvent', () => {
	it('posts the event to every connection open for the session', async () => {
		const connections = fakeConnections(['conn-1', 'conn-2']);
		const send = vi.fn().mockResolvedValue({});

		await relayEvent(connections, { send }, 'session-1', { type: 'phase_update', phase: { name: 'planning', status: 'started' } });

		expect(connections.query).toHaveBeenCalledWith('session-1');
		expect(send).toHaveBeenCalledTimes(2);
		const [command1] = send.mock.calls[0] as [{ input: { ConnectionId: string; Data: Buffer } }];
		expect(command1.input.ConnectionId).toBe('conn-1');
		expect(JSON.parse(command1.input.Data.toString())).toEqual({ type: 'phase_update', phase: { name: 'planning', status: 'started' } });
	});

	it('does nothing when no connection is open for the session', async () => {
		const connections = fakeConnections([]);
		const send = vi.fn();

		await relayEvent(connections, { send }, 'session-1', { type: 'terminal_output', command: 'ls', output: 'a.txt' });

		expect(send).not.toHaveBeenCalled();
	});

	it('does not let one failed delivery block another', async () => {
		const connections = fakeConnections(['stale-conn', 'live-conn']);
		const send = vi.fn().mockImplementation((command: { input: { ConnectionId: string } }) => {
			if (command.input.ConnectionId === 'stale-conn') return Promise.reject(new Error('GoneException'));
			return Promise.resolve({});
		});

		await expect(relayEvent(connections, { send }, 'session-1', { type: 'error', error: 'boom' })).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(2);
	});
});
