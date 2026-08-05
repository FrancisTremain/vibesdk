/**
 * Per-session target-group + host-header listener-rule lifecycle against
 * aws/infra/sandbox/alb.tf's shared preview ALB. One ALB, permanently --
 * each sandbox instance gets its own target group (one target: the
 * task's private IP on port 3000) and a listener rule that routes
 * `<instanceId>.<previewDomain>` to it. Both are created on instance
 * launch and torn down on shutdown; nothing here is provisioned by
 * Terraform since the whole point is that it's runtime, per-session state
 * (see alb.tf's header comment for why this isn't blue/green or
 * otherwise pre-provisioned).
 */

import {
	CreateRuleCommand,
	CreateTargetGroupCommand,
	DeleteRuleCommand,
	DeleteTargetGroupCommand,
	DescribeRulesCommand,
	RegisterTargetsCommand,
	type ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const DEV_PORT = 3000;
const MAX_PRIORITY_RETRIES = 5;

export interface AlbManagerConfig {
	elb: Pick<ElasticLoadBalancingV2Client, 'send'>;
	listenerArn: string;
	vpcId: string;
	previewDomain: string;
}

export interface PreviewRoute {
	targetGroupArn: string;
	ruleArn: string;
	hostname: string;
}

/** Target group names are capped at 32 chars, alphanumeric/hyphens only -- a
 *  UUID instanceId (36 chars, with hyphens) doesn't fit, so this strips
 *  hyphens and truncates rather than hashing: still unique enough (28 hex
 *  chars of a UUID) and keeps the name traceable back to the instanceId
 *  for debugging in the AWS console. */
function targetGroupName(instanceId: string): string {
	return `sbx-${instanceId.replace(/-/g, '').slice(0, 28)}`;
}

export class AlbManager {
	constructor(private readonly config: AlbManagerConfig) {}

	async registerRoute(instanceId: string, privateIp: string): Promise<PreviewRoute> {
		const tg = await this.config.elb.send(
			new CreateTargetGroupCommand({
				Name: targetGroupName(instanceId),
				Protocol: 'HTTP',
				Port: DEV_PORT,
				VpcId: this.config.vpcId,
				TargetType: 'ip',
				HealthCheckEnabled: true,
				HealthCheckPath: '/',
				HealthCheckIntervalSeconds: 10,
				HealthCheckTimeoutSeconds: 5,
				HealthyThresholdCount: 2,
				UnhealthyThresholdCount: 3,
			}),
		);
		const targetGroupArn = tg.TargetGroups?.[0]?.TargetGroupArn;
		if (!targetGroupArn) throw new Error('CreateTargetGroup did not return a target group ARN');

		await this.config.elb.send(
			new RegisterTargetsCommand({
				TargetGroupArn: targetGroupArn,
				Targets: [{ Id: privateIp, Port: DEV_PORT }],
			}),
		);

		const hostname = `${instanceId}.${this.config.previewDomain}`;
		try {
			const ruleArn = await this.createRuleWithRetry(targetGroupArn, hostname);
			return { targetGroupArn, ruleArn, hostname };
		} catch (err) {
			// Don't leak a target group with no route pointing at it if rule
			// creation exhausts its retries -- best-effort, the instance
			// creation itself is about to fail anyway.
			await this.config.elb.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroupArn })).catch(() => {});
			throw err;
		}
	}

	/** Listener rule priorities must be unique per listener and are caller-assigned
	 *  (no "auto" option in the API) -- lists what's taken and picks the lowest
	 *  free slot, retrying on a race against a concurrent launch picking the
	 *  same slot (PriorityInUse) rather than serializing all launches through a
	 *  lock this stateless Lambda has no natural place to hold. */
	private async createRuleWithRetry(targetGroupArn: string, hostname: string): Promise<string> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_PRIORITY_RETRIES; attempt++) {
			const priority = await this.findFreePriority();
			try {
				const result = await this.config.elb.send(
					new CreateRuleCommand({
						ListenerArn: this.config.listenerArn,
						Priority: priority,
						Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [hostname] } }],
						Actions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
					}),
				);
				const ruleArn = result.Rules?.[0]?.RuleArn;
				if (!ruleArn) throw new Error('CreateRule did not return a rule ARN');
				return ruleArn;
			} catch (err) {
				lastError = err;
				if ((err as { name?: string }).name !== 'PriorityInUseException') throw err;
			}
		}
		throw lastError instanceof Error ? lastError : new Error('Failed to create ALB listener rule after retries');
	}

	private async findFreePriority(): Promise<number> {
		const result = await this.config.elb.send(new DescribeRulesCommand({ ListenerArn: this.config.listenerArn }));
		const used = new Set(
			(result.Rules ?? [])
				.map((r) => r.Priority)
				.filter((p): p is string => !!p && p !== 'default')
				.map((p) => parseInt(p, 10)),
		);
		let priority = 1;
		while (used.has(priority)) priority++;
		return priority;
	}

	/** Best-effort on both calls -- a session that never fully registered
	 *  (e.g. bootstrap failed after the target group was created) shouldn't
	 *  block shutdown on cleanup of a route that may be partially missing. */
	async deregisterRoute(route: { ruleArn?: string; targetGroupArn?: string }): Promise<void> {
		if (route.ruleArn) {
			await this.config.elb.send(new DeleteRuleCommand({ RuleArn: route.ruleArn })).catch(() => {});
		}
		if (route.targetGroupArn) {
			await this.config.elb.send(new DeleteTargetGroupCommand({ TargetGroupArn: route.targetGroupArn })).catch(() => {});
		}
	}
}
