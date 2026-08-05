/** In-memory fakes for the ECS/EC2 SDK client subset EcsRunner uses. */

import type { RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';

export interface FakeEcsOptions {
	taskArn?: string;
	failRunTask?: string;
	lastStatus?: string;
	eniId?: string;
	stoppedReason?: string;
}

export class FakeEcsClient {
	readonly runTaskCalls: RunTaskCommand[] = [];
	readonly stopTaskCalls: StopTaskCommand[] = [];

	constructor(private readonly opts: FakeEcsOptions = {}) {}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;
		const taskArn = this.opts.taskArn ?? 'arn:aws:ecs:ap-southeast-2:111111111111:task/vibesdk-sandbox/fake';

		if (kind === 'RunTaskCommand') {
			this.runTaskCalls.push(command as RunTaskCommand);
			if (this.opts.failRunTask) return { tasks: [], failures: [{ reason: this.opts.failRunTask }] };
			return { tasks: [{ taskArn }] };
		}
		if (kind === 'DescribeTasksCommand') {
			return {
				tasks: [
					{
						taskArn,
						lastStatus: this.opts.lastStatus ?? 'RUNNING',
						stoppedReason: this.opts.stoppedReason,
						attachments: this.opts.eniId
							? [{ details: [{ name: 'networkInterfaceId', value: this.opts.eniId }] }]
							: [],
					},
				],
			};
		}
		if (kind === 'StopTaskCommand') {
			this.stopTaskCalls.push(command as StopTaskCommand);
			return {};
		}
		throw new Error(`FakeEcsClient: unhandled command ${kind}`);
	}
}

export class FakeEc2Client {
	constructor(
		private readonly publicIp = '203.0.113.5',
		private readonly privateIp = '10.42.1.10',
	) {}

	async send(command: unknown): Promise<unknown> {
		const kind = (command as { constructor?: { name?: string } })?.constructor?.name;
		if (kind === 'DescribeNetworkInterfacesCommand') {
			return { NetworkInterfaces: [{ Association: { PublicIp: this.publicIp }, PrivateIpAddress: this.privateIp }] };
		}
		throw new Error(`FakeEc2Client: unhandled command ${kind}`);
	}
}
