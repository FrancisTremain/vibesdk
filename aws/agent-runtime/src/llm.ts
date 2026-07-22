/**
 * Real implementation of messages.ts's `MessageDeps.generateReply`,
 * wired to vibesdk-llm-client. A single-turn completion over the
 * conversation history -- not worker/agents/operations/
 * UserConversationProcessor.ts's real conversational-AI handling (no
 * tool calling, no blueprint/project-state grounding, no streaming).
 * The system prompt is explicit about that gap so the model doesn't
 * paper over it.
 */

import { runInference, type ChatMessage } from 'vibesdk-llm-client';
import type { ConversationMessage } from './state';

const MODEL_ID = process.env.AGENT_MODEL_ID ?? 'anthropic/claude-sonnet-4-5';

const SYSTEM_PROMPT =
	'You are the conversational assistant for vibesdk, an AI app-generation platform. ' +
	'The AWS runtime handling this conversation does not yet implement the full code-generation ' +
	'pipeline (phase planning, file generation, sandbox execution, deployment) -- if the user asks ' +
	'for something that requires those, say so plainly rather than claiming to have done it. ' +
	'Otherwise, respond helpfully and concisely.';

function apiKeyEnvVarFor(provider: string): string {
	return `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}

export async function generateAssistantReply(history: ConversationMessage[], userMessage: string): Promise<string> {
	const provider = MODEL_ID.split('/')[0];
	if (!provider) throw new Error(`Invalid AGENT_MODEL_ID: ${MODEL_ID}`);

	const envVar = apiKeyEnvVarFor(provider);
	const apiKey = process.env[envVar];
	if (!apiKey) {
		throw new Error(`No API key configured for provider "${provider}" (expected ${envVar})`);
	}

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
		{ role: 'user', content: userMessage },
	];

	const result = await runInference({ modelId: MODEL_ID, apiKey, messages, maxTokens: 1024 });
	return result.content;
}
