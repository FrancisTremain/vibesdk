/** In-memory fake for the ElasticLoadBalancingV2 SDK client subset AlbManager uses. */

export interface FakeRule {
	RuleArn: string;
	Priority: string;
}

export class FakeElbClient {
	targetGroups = new Map<string, { arn: string }>();
	registeredTargets: { targetGroupArn: string; id: string; port: number }[] = [];
	rules: FakeRule[] = [];
	deletedTargetGroups: string[] = [];
	deletedRules: string[] = [];
	failNextCreateRuleWith?: string;
	private tgCounter = 0;
	private ruleCounter = 0;

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;
		const input = (command as { input: Record<string, unknown> }).input;

		if (kind === 'CreateTargetGroupCommand') {
			const arn = `arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:targetgroup/${input.Name}/${++this.tgCounter}`;
			this.targetGroups.set(arn, { arn });
			return { TargetGroups: [{ TargetGroupArn: arn }] };
		}
		if (kind === 'RegisterTargetsCommand') {
			const target = (input.Targets as { Id: string; Port: number }[])[0]!;
			this.registeredTargets.push({
				targetGroupArn: input.TargetGroupArn as string,
				id: target.Id,
				port: target.Port,
			});
			return {};
		}
		if (kind === 'DescribeRulesCommand') {
			return { Rules: this.rules };
		}
		if (kind === 'CreateRuleCommand') {
			if (this.failNextCreateRuleWith) {
				const name = this.failNextCreateRuleWith;
				this.failNextCreateRuleWith = undefined;
				const err = new Error(name);
				err.name = name;
				throw err;
			}
			const ruleArn = `arn:aws:elasticloadbalancing:ap-southeast-2:111111111111:listener-rule/app/vibesdk-sandbox-preview/x/${++this.ruleCounter}`;
			this.rules.push({ RuleArn: ruleArn, Priority: String(input.Priority) });
			return { Rules: [{ RuleArn: ruleArn }] };
		}
		if (kind === 'DeleteRuleCommand') {
			this.deletedRules.push(input.RuleArn as string);
			this.rules = this.rules.filter((r) => r.RuleArn !== input.RuleArn);
			return {};
		}
		if (kind === 'DeleteTargetGroupCommand') {
			this.deletedTargetGroups.push(input.TargetGroupArn as string);
			this.targetGroups.delete(input.TargetGroupArn as string);
			return {};
		}
		throw new Error(`FakeElbClient: unhandled command ${kind}`);
	}
}
