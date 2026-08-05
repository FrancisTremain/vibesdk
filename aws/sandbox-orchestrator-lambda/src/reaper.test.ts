import { describe, it, expect } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeDynamoDocumentClient } from './fake-dynamo';
import { SandboxInstancesStore, newExpiresAt, type SandboxInstanceRecord } from './instances-store';
import { reapOrphanedTasks } from './reaper';

const CLUSTER = 'vibesdk-sandbox';

class FakeListEcsClient {
	readonly stopTaskCalls: { taskArn: string; reason?: string }[] = [];
	constructor(private readonly runningTaskArns: string[]) {}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;
		if (kind === 'ListTasksCommand') return { taskArns: this.runningTaskArns };
		if (kind === 'StopTaskCommand') {
			const input = (command as { input: { task: string; reason?: string } }).input;
			this.stopTaskCalls.push({ taskArn: input.task, reason: input.reason });
			return {};
		}
		throw new Error(`FakeListEcsClient: unhandled command ${kind}`);
	}
}

class FakeAlbManager {
	readonly deregisterCalls: { ruleArn?: string; targetGroupArn?: string }[] = [];
	async deregisterRoute(route: { ruleArn?: string; targetGroupArn?: string }): Promise<void> {
		this.deregisterCalls.push(route);
	}
}

function makeStore(): { store: SandboxInstancesStore; ddb: FakeDynamoDocumentClient } {
	const ddb = new FakeDynamoDocumentClient();
	const store = new SandboxInstancesStore(ddb as unknown as DynamoDBDocumentClient, 'vibesdk-sandbox-instances-test');
	return { store, ddb };
}

function record(overrides: Partial<SandboxInstanceRecord>): SandboxInstanceRecord {
	return {
		instanceId: 'inst-1',
		taskArn: 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/a',
		status: 'RUNNING',
		projectName: 'demo',
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		expiresAt: newExpiresAt(),
		...overrides,
	};
}

describe('reapOrphanedTasks', () => {
	it('stops a running task with no tracking record at all', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/orphan';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([taskArn]);
		expect(ecs.stopTaskCalls).toHaveLength(1);
		expect(ecs.stopTaskCalls[0]?.reason).toContain('orphaned');
	});

	it('leaves a tracked, non-expired, non-error task alone', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/healthy';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'healthy-1', taskArn, status: 'RUNNING' }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([]);
		expect(ecs.stopTaskCalls).toHaveLength(0);
		expect(await store.get('healthy-1')).toBeDefined();
	});

	it('stops and cleans up a task whose tracking record is in ERROR status', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/errored';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'errored-1', taskArn, status: 'ERROR', error: 'fetch failed' }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([taskArn]);
		expect(await store.get('errored-1')).toBeUndefined();
	});

	it('stops and cleans up a task whose tracking record has expired', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/stale';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(
			record({ instanceId: 'stale-1', taskArn, status: 'RUNNING', expiresAt: Math.floor(Date.now() / 1000) - 60 }),
		);
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([taskArn]);
		expect(await store.get('stale-1')).toBeUndefined();
	});

	it('stops and cleans up a RUNNING task idle past the default 15-minute threshold', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/idle';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'idle-1', taskArn, status: 'RUNNING', lastActivityAt: Date.now() - 16 * 60 * 1000 }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([taskArn]);
		expect(ecs.stopTaskCalls[0]?.reason).toContain('idle for');
		expect(await store.get('idle-1')).toBeUndefined();
	});

	it('leaves a RUNNING task alone when it is idle but still under the threshold', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/almost-idle';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'almost-idle-1', taskArn, status: 'RUNNING', lastActivityAt: Date.now() - 10 * 60 * 1000 }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([]);
		expect(await store.get('almost-idle-1')).toBeDefined();
	});

	it('respects a custom idleTimeoutSeconds instead of the 15-minute default', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/custom-idle';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'custom-idle-1', taskArn, status: 'RUNNING', lastActivityAt: Date.now() - 120_000 }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER, idleTimeoutSeconds: 60 });

		expect(result.stoppedTaskArns).toEqual([taskArn]);
	});

	it('does not idle-reap a PROVISIONING task even if it has been stale for a while (bootstrap can legitimately take time)', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/provisioning';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(
			record({ instanceId: 'provisioning-1', taskArn, status: 'PROVISIONING', lastActivityAt: Date.now() - 16 * 60 * 1000 }),
		);
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.stoppedTaskArns).toEqual([]);
	});

	it('deregisters the ALB route when reaping a task that had one registered', async () => {
		const taskArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/withalb';
		const ecs = new FakeListEcsClient([taskArn]);
		const { store } = makeStore();
		await store.put(
			record({
				instanceId: 'withalb-1',
				taskArn,
				status: 'ERROR',
				albRuleArn: 'arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:listener-rule/x',
				albTargetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:targetgroup/y',
			}),
		);
		const albManager = new FakeAlbManager();

		await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(albManager.deregisterCalls).toEqual([
			{
				ruleArn: 'arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:listener-rule/x',
				targetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:targetgroup/y',
			},
		]);
	});

	it('handles a mix of healthy and reap-eligible tasks in one sweep', async () => {
		const healthyArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/healthy';
		const orphanArn = 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/orphan';
		const ecs = new FakeListEcsClient([healthyArn, orphanArn]);
		const { store } = makeStore();
		await store.put(record({ instanceId: 'healthy-2', taskArn: healthyArn, status: 'RUNNING' }));
		const albManager = new FakeAlbManager();

		const result = await reapOrphanedTasks({ ecs, store, albManager, cluster: CLUSTER });

		expect(result.totalRunning).toBe(2);
		expect(result.stoppedTaskArns).toEqual([orphanArn]);
	});
});
