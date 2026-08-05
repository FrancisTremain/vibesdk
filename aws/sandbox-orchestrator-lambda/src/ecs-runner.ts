/**
 * Drives ECS RunTask/DescribeTasks/StopTask for aws/infra/sandbox's
 * Fargate cluster -- launches one task per sandbox instance (no
 * standing pool, per that stack's design), waits for it to reach
 * RUNNING with an attached ENI, then resolves both the ENI's public IP
 * (control-plane calls from this Lambda, and direct-debug access) and
 * private IP (the ALB target -- aws/infra/sandbox/alb.tf's preview ALB
 * lives in the same VPC and reaches tasks over private networking).
 */

import { RunTaskCommand, DescribeTasksCommand, StopTaskCommand, type ECSClient } from '@aws-sdk/client-ecs';
import { DescribeNetworkInterfacesCommand, type EC2Client } from '@aws-sdk/client-ec2';

export interface EcsRunnerConfig {
	ecs: Pick<ECSClient, 'send'>;
	ec2: Pick<EC2Client, 'send'>;
	cluster: string;
	taskDefinitionArn: string;
	subnetIds: string[];
	securityGroupId: string;
	containerName: string;
	pollIntervalMs?: number;
	runningTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EcsRunner {
	private readonly pollIntervalMs: number;
	private readonly runningTimeoutMs: number;

	constructor(private readonly config: EcsRunnerConfig) {
		this.pollIntervalMs = config.pollIntervalMs ?? 2000;
		this.runningTimeoutMs = config.runningTimeoutMs ?? 90_000;
	}

	async runTask(instanceId: string): Promise<string> {
		const result = await this.config.ecs.send(
			new RunTaskCommand({
				cluster: this.config.cluster,
				taskDefinition: this.config.taskDefinitionArn,
				launchType: 'FARGATE',
				count: 1,
				networkConfiguration: {
					awsvpcConfiguration: {
						subnets: this.config.subnetIds,
						securityGroups: [this.config.securityGroupId],
						assignPublicIp: 'ENABLED',
					},
				},
				overrides: {
					containerOverrides: [
						{
							name: this.config.containerName,
							environment: [{ name: 'INSTANCE_ID', value: instanceId }],
						},
					],
				},
			}),
		);

		const taskArn = result.tasks?.[0]?.taskArn;
		if (!taskArn) {
			const failure = result.failures?.[0];
			throw new Error(`ECS RunTask failed to launch a task: ${failure?.reason ?? 'unknown reason'}`);
		}
		return taskArn;
	}

	/**
	 * Polls until the task is RUNNING with a resolvable public IP, or throws.
	 * Also resolves the private IP -- needed as the ALB target (aws/infra/sandbox/alb.tf's
	 * ALB lives in the same VPC and reaches tasks over private networking,
	 * not through the internet gateway the public IP implies).
	 */
	async waitForNetworking(taskArn: string): Promise<{ publicIp: string; privateIp: string }> {
		const deadline = Date.now() + this.runningTimeoutMs;

		while (Date.now() < deadline) {
			const result = await this.config.ecs.send(
				new DescribeTasksCommand({ cluster: this.config.cluster, tasks: [taskArn] }),
			);
			const task = result.tasks?.[0];

			if (task?.lastStatus === 'STOPPED') {
				throw new Error(`Sandbox task stopped before becoming reachable: ${task.stoppedReason ?? 'unknown reason'}`);
			}

			if (task?.lastStatus === 'RUNNING') {
				const eniId = task.attachments?.[0]?.details?.find((d) => d.name === 'networkInterfaceId')?.value;
				if (eniId) {
					const networking = await this.resolveNetworking(eniId);
					if (networking?.publicIp && networking.privateIp) {
						return { publicIp: networking.publicIp, privateIp: networking.privateIp };
					}
				}
			}

			await sleep(this.pollIntervalMs);
		}

		throw new Error('Timed out waiting for sandbox task to reach RUNNING with a public IP');
	}

	private async resolveNetworking(networkInterfaceId: string): Promise<{ publicIp?: string; privateIp?: string } | undefined> {
		const result = await this.config.ec2.send(
			new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [networkInterfaceId] }),
		);
		const eni = result.NetworkInterfaces?.[0];
		return { publicIp: eni?.Association?.PublicIp, privateIp: eni?.PrivateIpAddress };
	}

	async stopTask(taskArn: string): Promise<void> {
		await this.config.ecs.send(
			new StopTaskCommand({ cluster: this.config.cluster, task: taskArn, reason: 'sandbox shutdown' }),
		);
	}
}
