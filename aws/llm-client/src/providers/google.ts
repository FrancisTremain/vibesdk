/** Direct HTTP call to Google AI Studio's Gemini `generateContent` REST API -- no `@google/genai` SDK dependency. */

import { InferenceError, type ProviderAdapter } from '../types';

interface GeminiPart {
	text?: string;
}

interface GeminiResponse {
	candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
	error?: { message?: string };
}

export const callGoogleAiStudio: ProviderAdapter = async (request) => {
	const system = request.messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	const contents = request.messages
		.filter((m) => m.role !== 'system')
		// Gemini has no 'assistant' role -- 'model' is the equivalent.
		.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
	const res = await request.fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			contents,
			...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
			generationConfig: {
				maxOutputTokens: request.maxTokens ?? 4096,
				...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
			},
		}),
	});

	const json = (await res.json().catch(() => ({}))) as GeminiResponse;
	if (!res.ok) {
		throw new InferenceError(json.error?.message ?? `Google AI Studio request failed (${res.status})`, 'google-ai-studio', res.status);
	}

	const candidate = json.candidates?.[0];
	const content = (candidate?.content?.parts ?? [])
		.map((part) => part.text ?? '')
		.join('');

	return {
		content,
		stopReason: candidate?.finishReason ?? 'unknown',
		usage: {
			inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
			outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
		},
		provider: 'google-ai-studio',
		model: request.model,
	};
};
