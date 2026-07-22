import { describe, expect, it } from 'vitest';
import { signExportState, verifyExportState, type GitHubExportStatePayload } from './state-token';

const SECRET = 'test-secret';

describe('signExportState / verifyExportState', () => {
	it('round-trips a payload', async () => {
		const payload: GitHubExportStatePayload = {
			sessionId: 'session-1',
			repositoryName: 'my-app',
			description: 'a demo app',
			isPrivate: true,
			returnUrl: 'https://app.local/chat',
		};

		const token = await signExportState(payload, SECRET);
		const verified = await verifyExportState(token, SECRET);

		expect(verified).toMatchObject(payload);
	});

	it('returns null for a token signed with a different secret', async () => {
		const token = await signExportState(
			{ sessionId: 's', repositoryName: 'r', returnUrl: 'https://app.local' },
			SECRET,
		);
		expect(await verifyExportState(token, 'wrong-secret')).toBeNull();
	});

	it('returns null for garbage input', async () => {
		expect(await verifyExportState('not-a-jwt', SECRET)).toBeNull();
	});
});
