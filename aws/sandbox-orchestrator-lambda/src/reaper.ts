/**
 * Scheduled safety net against orphaned and idle sandbox ECS tasks -- the
 * class of bug handler.ts's createInstance previously had (bootstrap/
 * networking failure paths that never called runner.stopTask, see that
 * file's own comments). That code path is now fixed, but this exists as a
 * second, independent line of defense: the vibesdk-sandbox-instances
 * table's own TTL (instances-store.ts) only deletes the *tracking row*
 * after 4 hours -- it does nothing to the real ECS task, which is where
 * the actual money is spent. A silently-deleted row for a still-running
 * task is strictly worse than the bug this file guards against: it
 * removes the only record that the task was ever created at all. This
 * sweeps the cluster directly instead of trusting DynamoDB bookkeeping to
 * reflect reality.
 *
 * Reaps on three independent conditions: no tracking record at all
 * (orphaned), ERROR status, a fixed max-lifetime cap (expiresAt, unchanged
 * from creation), or -- the real point of lastActivityAt -- genuine user
 * inactivity (aws/harness-orchestrator-lambda forwards real generation
 * events here via sandbox-activity-client.ts, not just a coarse UI
 * heartbeat). expiresAt stays as a hard backstop even for an instance
 * that keeps getting touched, so nothing can run forever purely by
 * staying "active".
 *
 * Runs on an EventBridge schedule (aws/infra/sandbox/orchestrator.tf) --
 * not request-driven, so there's no caller to authenticate and no
 * ORCHESTRATOR_SECRET check here.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ECSClient, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { SandboxInstancesStore, type SandboxInstanceRecord } from './instances-store';
import { AlbManager } from './alb-manager';

export interface ReapDeps {
	ecs: Pick<ECSClient, 'send'>;
	store: SandboxInstancesStore;
	albManager: Pick<AlbManager, 'deregisterRoute'>;
	cluster: string;
	/** Seconds of no activity (lastActivityAt) before a RUNNING instance is reaped, independent of its hard expiresAt cap. Defaults to 900 (15 minutes). */
	idleTimeoutSeconds?: number;
}

export interface ReapResult {
	stoppedTaskArns: string[];
	totalRunning: number;
}

const DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60;

/** Exported for testing -- the handler wires real AWS clients and calls this. */
export async function reapOrphanedTasks(deps: ReapDeps): Promise<ReapResult> {
	const records = await deps.store.listAll();
	const byTaskArn = new Map<string, SandboxInstanceRecord>(records.map((r) => [r.taskArn, r]));

	const list = await deps.ecs.send(new ListTasksCommand({ cluster: deps.cluster, desiredStatus: 'RUNNING' }));
	const taskArns = list.taskArns ?? [];
	const nowMs = Date.now();
	const nowSeconds = Math.floor(nowMs / 1000);
	const idleTimeoutMs = (deps.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
	const stoppedTaskArns: string[] = [];

	for (const taskArn of taskArns) {
		const record = byTaskArn.get(taskArn);
		const idleMs = record ? nowMs - record.lastActivityAt : 0;
		const reason = !record
			? 'orphaned: no tracking record (bug or already TTL-expired)'
			: record.status === 'ERROR'
				? 'tracked record is in ERROR status'
				: record.expiresAt < nowSeconds
					? 'tracked record has exceeded its max lifetime'
					: record.status === 'RUNNING' && idleMs > idleTimeoutMs
						? `idle for ${Math.floor(idleMs / 1000)}s (limit ${deps.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS}s)`
						: null;
		if (!reason) continue;

		await deps.ecs
			.send(new StopTaskCommand({ cluster: deps.cluster, task: taskArn, reason: `sandbox-reaper: ${reason}` }))
			.catch((err) => console.error('sandbox-reaper: failed to stop task', taskArn, err));

		if (record) {
			if (record.albRuleArn || record.albTargetGroupArn) {
				await deps.albManager
					.deregisterRoute({ ruleArn: record.albRuleArn, targetGroupArn: record.albTargetGroupArn })
					.catch((err) => console.error('sandbox-reaper: failed to deregister ALB route', record.instanceId, err));
			}
			await deps.store
				.delete(record.instanceId)
				.catch((err) => console.error('sandbox-reaper: failed to delete tracking record', record.instanceId, err));
		}

		stoppedTaskArns.push(taskArn);
		console.log('sandbox-reaper: stopped orphaned task', { taskArn, reason, instanceId: record?.instanceId });
	}

	return { stoppedTaskArns, totalRunning: taskArns.length };
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} not configured`);
	return value;
}

export async function handler(): Promise<{ stopped: number; totalRunning: number }> {
	const cluster = requireEnv('ECS_CLUSTER');
	const tableName = requireEnv('SANDBOX_INSTANCES_TABLE');

	const ecs = new ECSClient({});
	const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
	const elb = new ElasticLoadBalancingV2Client({});
	const store = new SandboxInstancesStore(ddb, tableName);
	const albManager = new AlbManager({
		elb,
		listenerArn: requireEnv('ALB_LISTENER_ARN'),
		vpcId: requireEnv('SANDBOX_VPC_ID'),
		previewDomain: requireEnv('PREVIEW_DOMAIN'),
	});

	const idleTimeoutSeconds = Number(process.env.IDLE_TIMEOUT_SECONDS ?? DEFAULT_IDLE_TIMEOUT_SECONDS);
	const result = await reapOrphanedTasks({ ecs, store, albManager, cluster, idleTimeoutSeconds });
	console.log('sandbox-reaper: run complete', { stopped: result.stoppedTaskArns.length, totalRunning: result.totalRunning });
	return { stopped: result.stoppedTaskArns.length, totalRunning: result.totalRunning };
}
