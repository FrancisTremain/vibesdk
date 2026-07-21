/** Direct HTTP call to OpenAI's Chat Completions API -- no `openai` SDK dependency. */

import { InferenceError, type ProviderAdapter } from '../types';

interface OpenAiResponse {
	choices?: { message?: { content?: string }; finish_reason?: string }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
	error?: { message?: string };
}

export const callOpenAi: ProviderAdapter = async (request) => {
	// Chat Completions accepts a 'system' role message directly -- unlike
	// Anthropic's Messages API, no need to extract it into a top-level field.
	const res = await request.fetchImpl('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${request.apiKey}`,
		},
		body: JSON.stringify({
			model: request.model,
			messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
			max_tokens: request.maxTokens ?? 4096,
			...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
		}),
	});

	const json = (await res.json().catch(() => ({}))) as OpenAiResponse;
	if (!res.ok) {
		throw new InferenceError(json.error?.message ?? `OpenAI request failed (${res.status})`, 'openai', res.status);
	}

	const choice = json.choices?.[0];
	return {
		content: choice?.message?.content ?? '',
		stopReason: choice?.finish_reason ?? 'unknown',
		usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
		provider: 'openai',
		model: request.model,
	};
};
