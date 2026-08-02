/**
 * Drives ECS RunTask/DescribeTasks/StopTask for aws/infra/harness's
 * Fargate cluster -- launches one task per harness session (no
 * standing pool, per that stack's design), waits for it to reach
 * RUNNING with an attached ENI, then resolves the ENI's public IP
 * (the task's `assign_public_ip = true` config means there's no ALB
 * to look this up through -- see aws/infra/harness/main.tf's header
 * comment for why). Identical shape to
 * aws/sandbox-orchestrator-lambda/src/ecs-runner.ts -- duplicated
 * rather than shared, same reasoning as every other small file this
 * migration copies between packages.
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

	async runTask(sessionId: string): Promise<string> {
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
							environment: [{ name: 'SESSION_ID', value: sessionId }],
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

	/** Polls until the task is RUNNING with a resolvable public IP, or throws. */
	async waitForPublicIp(taskArn: string): Promise<string> {
		const deadline = Date.now() + this.runningTimeoutMs;

		while (Date.now() < deadline) {
			const result = await this.config.ecs.send(
				new DescribeTasksCommand({ cluster: this.config.cluster, tasks: [taskArn] }),
			);
			const task = result.tasks?.[0];

			if (task?.lastStatus === 'STOPPED') {
				throw new Error(`Harness task stopped before becoming reachable: ${task.stoppedReason ?? 'unknown reason'}`);
			}

			if (task?.lastStatus === 'RUNNING') {
				const eniId = task.attachments?.[0]?.details?.find((d) => d.name === 'networkInterfaceId')?.value;
				if (eniId) {
					const publicIp = await this.resolvePublicIp(eniId);
					if (publicIp) return publicIp;
				}
			}

			await sleep(this.pollIntervalMs);
		}

		throw new Error('Timed out waiting for harness task to reach RUNNING with a public IP');
	}

	private async resolvePublicIp(networkInterfaceId: string): Promise<string | undefined> {
		const result = await this.config.ec2.send(
			new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [networkInterfaceId] }),
		);
		return result.NetworkInterfaces?.[0]?.Association?.PublicIp;
	}

	async stopTask(taskArn: string): Promise<void> {
		await this.config.ecs.send(
			new StopTaskCommand({ cluster: this.config.cluster, task: taskArn, reason: 'harness shutdown' }),
		);
	}
}
