/**
 * Real implementation of messages.ts's `MessageDeps.runGeneration` --
 * what `generate_all` actually does on this runtime.
 *
 * NOT a port of worker/agents/operations/PhaseGeneration.ts +
 * PhaseImplementation.ts + the SCOF streaming format
 * (worker/agents/output-formats/streaming-formats/scof.ts) those rely
 * on. That system plans multiple phases, generates/diffs files phase
 * by phase with a custom streaming parser, and runs static analysis +
 * deterministic fixups between phases. This is a deliberate
 * simplification: one LLM call asking for a small complete app as a
 * single JSON object, then one call to aws/sandbox-orchestrator-lambda
 * to actually run it, then a best-effort commit of the same files to
 * this session's git history in S3 (./git-commit.ts). No phases, no
 * diffing, no fix-up loop, no streaming file-by-file progress events.
 * See this package's README for why that's an honest tradeoff to ship
 * a real end-to-end path with, rather than a half-built phase system.
 */

import { runInference } from 'vibesdk-llm-client';
import { MODEL_ID, resolveApiKey } from './model';
import { createSandboxInstance } from './sandbox-client';
import { commitGeneratedFiles } from './git-commit';

export interface GeneratedFile {
	filePath: string;
	fileContents: string;
}

export interface GeneratedProject {
	projectName: string;
	initCommand: string;
	files: GeneratedFile[];
}

export interface GenerationResult extends GeneratedProject {
	previewUrl?: string;
	sandboxInstanceId?: string;
	bootstrapMessage?: string;
	gitCommitSha?: string;
	/** Set instead of throwing when the git-storage commit fails -- see ./git-commit.ts for why this path is best-effort, not all-or-nothing like the rest of generate_all. */
	gitCommitError?: string;
}

const SYSTEM_PROMPT = `You are a code generator for vibesdk, an AI app-generation platform running on a minimal AWS runtime.
Given a short app description, generate a small, complete, runnable web app.

Output ONLY a single JSON object -- no markdown code fences, no commentary before or after it. Shape:
{"projectName": string, "initCommand": string, "files": [{"filePath": string, "fileContents": string}]}

Rules:
- Keep it small: a handful of files, not a large multi-page app.
- "initCommand" must be a single shell command that starts a dev server listening on port 3000 (e.g. "bun run dev" or "npm start"). Include a package.json with a matching script and a minimal, real, correctly-versioned dependency list.
- Do not invent external services, databases, or API keys the app can't actually run without.
- Every file's "fileContents" must be the complete, final file content -- no diffs, no placeholders like "// rest of the code".`;

export async function generateProjectFiles(description: string): Promise<GeneratedProject> {
	const apiKey = resolveApiKey(MODEL_ID);
	const result = await runInference({
		modelId: MODEL_ID,
		apiKey,
		maxTokens: 8192,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: description },
		],
	});
	return parseGeneratedProject(result.content);
}

/** Exported for direct unit testing of the parsing/validation logic without a network call. */
export function parseGeneratedProject(raw: string): GeneratedProject {
	const jsonText = extractJson(raw);

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`Model did not return valid JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Model response was not a JSON object');
	}
	const obj = parsed as Record<string, unknown>;

	if (!Array.isArray(obj.files) || obj.files.length === 0) {
		throw new Error('Model response had no files');
	}
	const files: GeneratedFile[] = obj.files.map((entry, index) => {
		if (typeof entry !== 'object' || entry === null) throw new Error(`files[${index}] was not an object`);
		const file = entry as Record<string, unknown>;
		if (typeof file.filePath !== 'string' || !file.filePath) throw new Error(`files[${index}] is missing filePath`);
		if (typeof file.fileContents !== 'string') throw new Error(`files[${index}] ("${file.filePath}") is missing fileContents`);
		return { filePath: file.filePath, fileContents: file.fileContents };
	});

	const projectName = typeof obj.projectName === 'string' && obj.projectName ? obj.projectName : 'generated-app';
	const initCommand = typeof obj.initCommand === 'string' && obj.initCommand ? obj.initCommand : 'bun run dev';

	return { projectName, initCommand, files };
}

/** Tolerates a model wrapping the JSON in a markdown fence despite being told not to. */
function extractJson(raw: string): string {
	const trimmed = raw.trim();
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	return fenceMatch?.[1] ?? trimmed;
}

export async function runGeneration(description: string, sessionId: string, fetchImpl: typeof fetch = fetch): Promise<GenerationResult> {
	const project = await generateProjectFiles(description);
	const sandbox = await createSandboxInstance(project.files, project.projectName, project.initCommand, fetchImpl);

	const result: GenerationResult = {
		...project,
		previewUrl: sandbox.previewURL,
		sandboxInstanceId: sandbox.runId,
		bootstrapMessage: typeof sandbox.message === 'string' ? sandbox.message : undefined,
	};

	try {
		const { commitSha } = await commitGeneratedFiles(sessionId, project.files, `Generate: ${project.projectName}`);
		result.gitCommitSha = commitSha;
	} catch (err) {
		result.gitCommitError = err instanceof Error ? err.message : String(err);
	}

	return result;
}
