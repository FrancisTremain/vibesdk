import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { AuditLogStore, SystemSettingsStore } from './audit-store';

function makeStores() {
	const fake = new FakeDynamoDocumentClient();
	const table = fake as unknown as DynamoDBDocumentClient;
	return { audit: new AuditLogStore(table, 'test-audit'), settings: new SystemSettingsStore(table, 'test-audit') };
}

describe('AuditLogStore', () => {
	it('records and lists entries for one entity', async () => {
		const { audit } = makeStores();
		await audit.record({
			userId: 'u1',
			entityType: 'session',
			entityId: 's1',
			action: 'device_change',
			oldValues: null,
			newValues: { ip: '1.2.3.4' },
			ipAddress: '1.2.3.4',
			userAgent: 'test-agent',
		});
		await audit.record({
			userId: 'u1',
			entityType: 'session',
			entityId: 's1',
			action: 'suspicious_activity',
			oldValues: null,
			newValues: null,
			ipAddress: '1.2.3.4',
			userAgent: 'test-agent',
		});

		const entries = await audit.listForEntity('session', 's1');
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.action).sort()).toEqual(['device_change', 'suspicious_activity']);
	});

	it('lists a user\'s events across entities via the by-user index, most recent first', async () => {
		const { audit } = makeStores();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		await audit.record({ userId: 'u1', entityType: 'session', entityId: 's1', action: 'device_change', oldValues: null, newValues: null, ipAddress: null, userAgent: null });

		vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
		await audit.record({ userId: 'u1', entityType: 'session', entityId: 's2', action: 'session_hijacking', oldValues: null, newValues: null, ipAddress: null, userAgent: null });

		await audit.record({ userId: 'u2', entityType: 'session', entityId: 's3', action: 'device_change', oldValues: null, newValues: null, ipAddress: null, userAgent: null });
		vi.useRealTimers();

		const events = await audit.listForUser('u1');
		expect(events).toHaveLength(2);
		expect(events[0]!.action).toBe('session_hijacking');
		expect(events[1]!.action).toBe('device_change');
	});

	it('bounds listForUser to events at or after sinceMs', async () => {
		const { audit } = makeStores();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		await audit.record({ userId: 'u1', entityType: 'session', entityId: 's1', action: 'device_change', oldValues: null, newValues: null, ipAddress: null, userAgent: null });
		const cutoff = Date.now();

		vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
		await audit.record({ userId: 'u1', entityType: 'session', entityId: 's2', action: 'session_hijacking', oldValues: null, newValues: null, ipAddress: null, userAgent: null });
		vi.useRealTimers();

		const recent = await audit.listForUser('u1', cutoff);
		expect(recent).toHaveLength(1);
		expect(recent[0]!.action).toBe('session_hijacking');
	});

	it('does not index entries with no userId in the by-user lookup', async () => {
		const { audit } = makeStores();
		await audit.record({ userId: null, entityType: 'session', entityId: 's1', action: 'device_change', oldValues: null, newValues: null, ipAddress: null, userAgent: null });

		const entries = await audit.listForEntity('session', 's1');
		expect(entries).toHaveLength(1);
	});
});

describe('SystemSettingsStore', () => {
	it('returns null for an unset key', async () => {
		const { settings } = makeStores();
		expect(await settings.get('feature.foo')).toBeNull();
	});

	it('sets and retrieves a value', async () => {
		const { settings } = makeStores();
		await settings.set('feature.foo', { enabled: true }, 'admin-1', 'Feature flag');

		const fetched = await settings.get('feature.foo');
		expect(fetched).toMatchObject({ key: 'feature.foo', value: { enabled: true }, updatedBy: 'admin-1' });
	});

	it('preserves the original id and description across updates that omit them', async () => {
		const { settings } = makeStores();
		const first = await settings.set('feature.bar', 1, 'admin-1', 'Bar setting');
		const second = await settings.set('feature.bar', 2, 'admin-2');

		expect(second.id).toBe(first.id);
		expect(second.description).toBe('Bar setting');
		expect(second.value).toBe(2);
		expect(second.updatedBy).toBe('admin-2');
	});
});
