import { describe, it, expect } from 'vitest';
import { AlbManager } from './alb-manager';
import { FakeElbClient } from './fake-elb';

function manager(elb: FakeElbClient) {
	return new AlbManager({
		elb,
		listenerArn: 'arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:listener/app/vibesdk-sandbox-preview/x/y',
		vpcId: 'vpc-123',
		previewDomain: 'preview.test',
	});
}

describe('AlbManager.registerRoute', () => {
	it('creates a target group, registers the private IP, and creates a host-header rule', async () => {
		const elb = new FakeElbClient();
		const route = await manager(elb).registerRoute('abc12345-0000-0000-0000-000000000000', '10.42.1.10');

		expect(route.hostname).toBe('abc12345-0000-0000-0000-000000000000.preview.test');
		expect(route.targetGroupArn).toContain('sbx-abc123450000000000000000');
		expect(elb.registeredTargets).toEqual([
			{ targetGroupArn: route.targetGroupArn, id: '10.42.1.10', port: 3000 },
		]);
		expect(elb.rules).toHaveLength(1);
		expect(elb.rules[0]?.RuleArn).toBe(route.ruleArn);
	});

	it('picks the lowest free priority, not always 1', async () => {
		const elb = new FakeElbClient();
		elb.rules.push({ RuleArn: 'arn:existing:1', Priority: '1' }, { RuleArn: 'arn:existing:2', Priority: '2' });

		const route = await manager(elb).registerRoute('session-two', '10.42.1.11');

		const created = elb.rules.find((r) => r.RuleArn === route.ruleArn);
		expect(created?.Priority).toBe('3');
	});

	it('retries on a priority race (PriorityInUseException) and still succeeds', async () => {
		const elb = new FakeElbClient();
		elb.failNextCreateRuleWith = 'PriorityInUseException';

		const route = await manager(elb).registerRoute('session-three', '10.42.1.12');

		expect(route.ruleArn).toBeTruthy();
		expect(elb.rules).toHaveLength(1);
	});

	it('cleans up the target group if rule creation fails for a non-retryable reason', async () => {
		const elb = new FakeElbClient();
		elb.failNextCreateRuleWith = 'ValidationException';

		await expect(manager(elb).registerRoute('session-four', '10.42.1.13')).rejects.toThrow('ValidationException');
		expect(elb.deletedTargetGroups).toHaveLength(1);
	});
});

describe('AlbManager.deregisterRoute', () => {
	it('deletes both the rule and the target group', async () => {
		const elb = new FakeElbClient();
		const route = await manager(elb).registerRoute('session-five', '10.42.1.14');

		await manager(elb).deregisterRoute(route);

		expect(elb.deletedRules).toEqual([route.ruleArn]);
		expect(elb.deletedTargetGroups).toEqual([route.targetGroupArn]);
	});

	it('tolerates missing arns (partial registration) without throwing', async () => {
		const elb = new FakeElbClient();
		await expect(manager(elb).deregisterRoute({})).resolves.toBeUndefined();
	});
});
