/** Direct HTTP call to Anthropic's Messages API -- no @anthropic-ai/sdk dependency. */

import { InferenceError, type ProviderAdapter } from '../types';

interface AnthropicContentBlock {
	type: string;
	text?: string;
}

interface AnthropicResponse {
	content?: AnthropicContentBlock[];
	stop_reason?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
	error?: { message?: string };
}

export const callAnthropic: ProviderAdapter = async (request) => {
	const system = request.messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	const messages = request.messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({ role: m.role, content: m.content }));

	const res = await request.fetchImpl('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': request.apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: request.model,
			max_tokens: request.maxTokens ?? 4096,
			...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
			...(system ? { system } : {}),
			messages,
		}),
	});

	const json = (await res.json().catch(() => ({}))) as AnthropicResponse;
	if (!res.ok) {
		throw new InferenceError(json.error?.message ?? `Anthropic request failed (${res.status})`, 'anthropic', res.status);
	}

	const content = (json.content ?? [])
		.filter((block) => block.type === 'text' && block.text)
		.map((block) => block.text)
		.join('');

	return {
		content,
		stopReason: json.stop_reason ?? 'unknown',
		usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
		provider: 'anthropic',
		model: request.model,
	};
};
