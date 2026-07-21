/**
 * Wrapper around the vibesdk-sandbox-instances DynamoDB table
 * (aws/infra/sandbox/main.tf: single hash key `instanceId`, no sort
 * key -- one item per Fargate task). Tracks the instanceId -> ECS task
 * ARN + public IP mapping the orchestrator needs to proxy per-instance
 * control-plane calls, since the Lambda itself is stateless between
 * invocations.
 */

import {
	DeleteCommand,
	GetCommand,
	PutCommand,
	ScanCommand,
	UpdateCommand,
	type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

export type SandboxInstanceStatus = 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'ERROR';

export interface SandboxInstanceRecord {
	instanceId: string;
	taskArn: string;
	publicIp?: string;
	status: SandboxInstanceStatus;
	projectName: string;
	createdAt: number;
	expiresAt: number;
	error?: string;
}

// Sandbox sessions are short-lived; TTL cleans up stale rows (e.g. a
// task that died without the shutdown route being called) without a
// separate reaper.
const TTL_SECONDS = 4 * 60 * 60;

export function newExpiresAt(): number {
	return Math.floor(Date.now() / 1000) + TTL_SECONDS;
}

export class SandboxInstancesStore {
	constructor(
		private readonly ddb: DynamoDBDocumentClient,
		private readonly tableName: string,
	) {}

	async put(record: SandboxInstanceRecord): Promise<void> {
		await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: record }));
	}

	async get(instanceId: string): Promise<SandboxInstanceRecord | undefined> {
		const result = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { instanceId } }));
		return result.Item as SandboxInstanceRecord | undefined;
	}

	async listAll(): Promise<SandboxInstanceRecord[]> {
		const result = await this.ddb.send(new ScanCommand({ TableName: this.tableName }));
		return (result.Items ?? []) as SandboxInstanceRecord[];
	}

	async update(instanceId: string, patch: Partial<Omit<SandboxInstanceRecord, 'instanceId'>>): Promise<void> {
		const names: Record<string, string> = {};
		const values: Record<string, unknown> = {};
		const sets: string[] = [];

		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			names[`#${key}`] = key;
			values[`:${key}`] = value;
			sets.push(`#${key} = :${key}`);
		}
		if (sets.length === 0) return;

		await this.ddb.send(
			new UpdateCommand({
				TableName: this.tableName,
				Key: { instanceId },
				UpdateExpression: `SET ${sets.join(', ')}`,
				ExpressionAttributeNames: names,
				ExpressionAttributeValues: values,
			}),
		);
	}

	async delete(instanceId: string): Promise<void> {
		await this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: { instanceId } }));
	}
}
