/**
 * Ported subset of worker/services/sandbox/sandboxTypes.ts -- pure zod
 * schemas/types, no Cloudflare dependency in the original either.
 * Template-catalog types (TemplateInfo/TemplateDetails, served from R2
 * in the original) and the webhook/GitHub-push types are not ported
 * here -- out of scope for the control-plane contract this package
 * defines. See this package's README for what "contract, not
 * implementation" means and why.
 */

import * as z from 'zod';

export interface FileTreeNode {
	path: string;
	type: 'file' | 'directory';
	children?: FileTreeNode[];
}

export const FileTreeNodeSchema: z.ZodType<FileTreeNode> = z.lazy(() =>
	z.object({
		path: z.string(),
		type: z.enum(['file', 'directory']),
		children: z.array(FileTreeNodeSchema).optional(),
	}),
);

export const TemplateFileSchema = z.object({
	filePath: z.string(),
	fileContents: z.string(),
});
export type TemplateFile = z.infer<typeof TemplateFileSchema>;

export const SimpleErrorSchema = z.object({
	timestamp: z.string(),
	level: z.number(),
	message: z.string(),
	rawOutput: z.string(),
});
export type SimpleError = z.infer<typeof SimpleErrorSchema>;

export const RuntimeErrorSchema = SimpleErrorSchema;
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const InstanceCreationRequestSchema = z.object({
	files: z.array(TemplateFileSchema),
	projectName: z.string(),
	webhookUrl: z.string().url().optional(),
	envVars: z.record(z.string(), z.string()).optional(),
	initCommand: z.string().default('bun run dev'),
});
export type InstanceCreationRequest = z.infer<typeof InstanceCreationRequestSchema>;

export const InstanceDetailsSchema = z.object({
	runId: z.string(),
	startTime: z.union([z.string(), z.date()]),
	uptime: z.number(),
	previewURL: z.string().optional(),
	tunnelURL: z.string().optional(),
	directory: z.string(),
	serviceDirectory: z.string(),
	fileTree: FileTreeNodeSchema.optional(),
	runtimeErrors: z.array(RuntimeErrorSchema).optional(),
	processId: z.string().optional(),
});
export type InstanceDetails = z.infer<typeof InstanceDetailsSchema>;

export const CommandExecutionResultSchema = z.object({
	command: z.string(),
	success: z.boolean(),
	output: z.string(),
	error: z.string().optional(),
	exitCode: z.number().optional(),
});
export type CommandExecutionResult = z.infer<typeof CommandExecutionResultSchema>;

export const PreviewSchema = z.object({
	runId: z.string().optional(),
	previewURL: z.string().optional(),
	tunnelURL: z.string().optional(),
});

export const BootstrapResponseSchema = PreviewSchema.extend({
	success: z.boolean(),
	processId: z.string().optional(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export const BootstrapStatusResponseSchema = z.object({
	success: z.boolean(),
	pending: z.boolean(),
	message: z.string().optional(),
	previewURL: z.string().optional(),
	tunnelURL: z.string().optional(),
	processId: z.string().optional(),
	isHealthy: z.boolean(),
	error: z.string().optional(),
});
export type BootstrapStatusResponse = z.infer<typeof BootstrapStatusResponseSchema>;

export const ListInstancesResponseSchema = z.object({
	success: z.boolean(),
	instances: z.array(InstanceDetailsSchema),
	count: z.number(),
	error: z.string().optional(),
});
export type ListInstancesResponse = z.infer<typeof ListInstancesResponseSchema>;

export const GetInstanceResponseSchema = z.object({
	success: z.boolean(),
	instance: InstanceDetailsSchema.optional(),
	error: z.string().optional(),
});
export type GetInstanceResponse = z.infer<typeof GetInstanceResponseSchema>;

export const WriteFilesRequestSchema = z.object({
	files: z.array(z.object({ filePath: z.string(), fileContents: z.string() })),
	commitMessage: z.string().optional(),
});
export type WriteFilesRequest = z.infer<typeof WriteFilesRequestSchema>;

export const GetFilesResponseSchema = z.object({
	success: z.boolean(),
	files: z.array(TemplateFileSchema),
	errors: z.array(z.object({ file: z.string(), error: z.string() })).optional(),
	error: z.string().optional(),
});
export type GetFilesResponse = z.infer<typeof GetFilesResponseSchema>;

export const WriteFilesResponseSchema = z.object({
	success: z.boolean(),
	message: z.string().optional(),
	results: z.array(z.object({ file: z.string(), success: z.boolean(), error: z.string().optional() })),
	error: z.string().optional(),
});
export type WriteFilesResponse = z.infer<typeof WriteFilesResponseSchema>;

export const GetLogsResponseSchema = z.object({
	success: z.boolean(),
	logs: z.object({ stdout: z.string(), stderr: z.string() }),
	error: z.string().optional(),
});
export type GetLogsResponse = z.infer<typeof GetLogsResponseSchema>;

export const ExecuteCommandsResponseSchema = z.object({
	success: z.boolean(),
	results: z.array(CommandExecutionResultSchema),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type ExecuteCommandsResponse = z.infer<typeof ExecuteCommandsResponseSchema>;

export const RuntimeErrorResponseSchema = z.object({
	success: z.boolean(),
	errors: z.array(RuntimeErrorSchema),
	hasErrors: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeErrorResponse = z.infer<typeof RuntimeErrorResponseSchema>;

export const ClearErrorsResponseSchema = z.object({
	success: z.boolean(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type ClearErrorsResponse = z.infer<typeof ClearErrorsResponseSchema>;

export const ShutdownResponseSchema = z.object({
	success: z.boolean(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type ShutdownResponse = z.infer<typeof ShutdownResponseSchema>;

export const LintSeveritySchema = z.enum(['error', 'warning', 'info']);
export type LintSeverity = z.infer<typeof LintSeveritySchema>;

export const CodeIssueSchema = z.object({
	message: z.string(),
	filePath: z.string(),
	line: z.number(),
	column: z.number().optional(),
	severity: LintSeveritySchema,
	ruleId: z.string().optional(),
	source: z.string().optional(),
});
export type CodeIssue = z.infer<typeof CodeIssueSchema>;

export const CodeIssueResponseSchema = z.object({
	issues: z.array(CodeIssueSchema),
	summary: z.object({ errorCount: z.number(), warningCount: z.number(), infoCount: z.number() }).optional(),
	rawOutput: z.string().optional(),
});
export type CodeIssueResponse = z.infer<typeof CodeIssueResponseSchema>;

export const StaticAnalysisResponseSchema = z.object({
	success: z.boolean(),
	lint: CodeIssueResponseSchema,
	typecheck: CodeIssueResponseSchema,
	error: z.string().optional(),
});
export type StaticAnalysisResponse = z.infer<typeof StaticAnalysisResponseSchema>;

/**
 * Renamed from the original's `DeploymentResult` used by
 * `deployToCloudflareWorkers` -- same shape, provider-neutral name,
 * since the confirmed product decision (docs/aws-migration-product-design.md)
 * is that the deploy target itself changes from Cloudflare Workers to
 * AWS on this port.
 */
export const DeploymentResultSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	deployedUrl: z.string().optional(),
	deploymentId: z.string().optional(),
	output: z.string().optional(),
	error: z.string().optional(),
});
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
