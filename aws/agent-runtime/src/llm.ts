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
import { MODEL_ID, resolveApiKey } from './model';

const SYSTEM_PROMPT =
	'You are the conversational assistant for vibesdk, an AI app-generation platform. ' +
	'The AWS runtime handling this conversation does not yet implement the full code-generation ' +
	'pipeline (phase planning, file generation, sandbox execution, deployment) -- if the user asks ' +
	'for something that requires those, say so plainly rather than claiming to have done it. ' +
	'Otherwise, respond helpfully and concisely.';

export async function generateAssistantReply(history: ConversationMessage[], userMessage: string): Promise<string> {
	const apiKey = resolveApiKey(MODEL_ID);

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
		{ role: 'user', content: userMessage },
	];

	const result = await runInference({ modelId: MODEL_ID, apiKey, messages, maxTokens: 1024 });
	return result.content;
}
