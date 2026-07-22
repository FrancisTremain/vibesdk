/**
 * Real implementation of messages.ts's `MessageDeps.deployProject` --
 * what the `deploy` message actually does on this runtime.
 *
 * NOT a port of the original deployment manager
 * (`wrangler.jsonc` + Workers-for-Platforms dispatch, replaced per
 * `docs/aws-migration-technical-design.md`'s design with "vibesdk's
 * own blue-green Terraform module for apps a user explicitly deploys
 * long-term" -- explicitly called out there as "the biggest
 * architectural change from how vibesdk deploys today" and not
 * attempted here). No blue-green pipeline, no custom domains, no
 * separate hosting tier exists yet.
 *
 * What this does instead: launches a second, independent Fargate task
 * via the same aws/sandbox-orchestrator-lambda `generate_all` already
 * uses (`./sandbox-client.ts`'s `createSandboxInstance`), from the
 * files already generated and persisted on session state -- no new
 * LLM call. The only real distinction from a preview instance is
 * lifecycle independence: this instance isn't tied to the live coding
 * session's `sandbox_instance_id`, so regenerating or closing the
 * session doesn't take the "deployed" app down with it. Whether that
 * distinction is durable depends on nothing else in this migration
 * ever building idle-eviction for sandbox tasks (see
 * aws/sandbox-orchestrator-lambda's README -- it doesn't exist yet
 * either, so today *every* sandbox task, preview or deploy, runs
 * until explicitly shut down).
 */

import { createSandboxInstance } from './sandbox-client';
import type { GeneratedFile } from './generation';

export interface DeployResult {
	deployedUrl: string;
	deploymentInstanceId: string;
}

export async function deployProject(
	files: GeneratedFile[],
	projectName: string,
	initCommand: string,
	fetchImpl: typeof fetch = fetch,
): Promise<DeployResult> {
	const sandbox = await createSandboxInstance(files, projectName, initCommand, fetchImpl);
	if (!sandbox.previewURL || !sandbox.runId) {
		throw new Error('Deployment sandbox did not return a preview URL');
	}
	return { deployedUrl: sandbox.previewURL, deploymentInstanceId: sandbox.runId };
}
