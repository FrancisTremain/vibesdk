/**
 * Target interface for an AWS sandbox client -- ported from the
 * abstract method surface of worker/services/sandbox/BaseSandboxService.ts
 * ("All implementations MUST support every method defined here").
 *
 * THIS IS A CONTRACT, NOT AN IMPLEMENTATION. No class in this package
 * implements `SandboxServiceClient`. See this package's README for why:
 * in short, the original's real implementation
 * (worker/services/sandbox/sandboxSdkClient.ts) talks to Cloudflare's
 * proprietary `@cloudflare/sandbox` SDK and the `cloudflare/sandbox`
 * base container image (see ../../SandboxDockerfile) -- a control-plane
 * protocol (bootstrap/write-files/exec-commands/get-logs/deploy, all
 * implemented inside that proprietary image) that has no publicly
 * documented equivalent to port against. Building an AWS replacement
 * means *designing* an equivalent protocol and a container image that
 * speaks it, not porting existing logic -- a materially different kind
 * of task than everything else in this migration.
 *
 * What this interface *is* useful for now: a concrete, typed target
 * that any future ECS-based implementation (or a control-plane HTTP
 * server design) needs to satisfy, derived directly from what the real
 * product's Durable Object callers actually call today.
 *
 * `deployToCloudflareWorkers` is renamed `deploy` and its
 * `DeploymentTarget` param dropped (that type is Cloudflare-Workers-
 * specific, defined in worker/agents/core/types.ts) -- the confirmed
 * product decision is that the deploy target itself changes to AWS on
 * this port, so there's no "deploy to Cloudflare Workers" case for an
 * AWS implementation to have.
 *
 * `updateProjectName`, the GitHub-push methods, and template listing
 * (a static/R2-backed catalog lookup, not per-instance) are also not
 * part of this interface -- template listing doesn't touch the
 * sandbox itself (it's a static catalog fetch), and GitHub push is a
 * separate, unexamined integration (worker/api/controllers/githubExporter/).
 */

import type {
	BootstrapResponse,
	BootstrapStatusResponse,
	ClearErrorsResponse,
	DeploymentResult,
	ExecuteCommandsResponse,
	GetFilesResponse,
	GetInstanceResponse,
	GetLogsResponse,
	InstanceCreationRequest,
	ListInstancesResponse,
	RuntimeErrorResponse,
	ShutdownResponse,
	StaticAnalysisResponse,
	WriteFilesRequest,
	WriteFilesResponse,
} from './types';

export interface SandboxServiceClient {
	initialize(): Promise<void>;

	// --- Instance lifecycle ---
	createInstance(options: InstanceCreationRequest): Promise<BootstrapResponse>;
	listAllInstances(): Promise<ListInstancesResponse>;
	getInstanceDetails(instanceId: string): Promise<GetInstanceResponse>;
	getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse>;
	shutdownInstance(instanceId: string): Promise<ShutdownResponse>;

	// --- File operations ---
	writeFiles(instanceId: string, files: WriteFilesRequest['files'], commitMessage?: string): Promise<WriteFilesResponse>;
	getFiles(instanceId: string, filePaths?: string[]): Promise<GetFilesResponse>;
	getLogs(instanceId: string, onlyRecent?: boolean, durationSeconds?: number): Promise<GetLogsResponse>;

	// --- Command execution ---
	executeCommands(instanceId: string, commands: string[], timeout?: number): Promise<ExecuteCommandsResponse>;

	// --- Error management ---
	getInstanceErrors(instanceId: string, clear?: boolean): Promise<RuntimeErrorResponse>;
	clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse>;

	// --- Code analysis ---
	runStaticAnalysisCode(instanceId: string, lintFiles?: string[]): Promise<StaticAnalysisResponse>;

	// --- Deployment ---
	deploy(instanceId: string): Promise<DeploymentResult>;
}
