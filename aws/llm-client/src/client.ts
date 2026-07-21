import { InferenceError, type InferenceRequest, type InferenceResponse, type ProviderAdapter } from './types';
import { callAnthropic } from './providers/anthropic';
import { callOpenAi } from './providers/openai';
import { callGoogleAiStudio } from './providers/google';

const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
	anthropic: callAnthropic,
	openai: callOpenAi,
	'google-ai-studio': callGoogleAiStudio,
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseModelId(modelId: string): { provider: string; model: string } {
	const separator = modelId.indexOf('/');
	if (separator === -1) {
		throw new InferenceError(`Invalid modelId (expected "provider/model-name"): ${modelId}`, 'unknown');
	}
	return { provider: modelId.slice(0, separator), model: modelId.slice(separator + 1) };
}

async function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInference(request: InferenceRequest): Promise<InferenceResponse> {
	const { provider, model } = parseModelId(request.modelId);
	const adapter = PROVIDER_ADAPTERS[provider];
	if (!adapter) {
		throw new InferenceError(
			`Unsupported provider: ${provider} (supported: ${Object.keys(PROVIDER_ADAPTERS).join(', ')})`,
			provider,
		);
	}

	const resolved = {
		...request,
		provider,
		model,
		fetchImpl: request.fetchImpl ?? fetch,
	};
	const sleep = request.sleepImpl ?? defaultSleep;
	const attempts = request.retryAttempts ?? 3;
	const baseDelayMs = request.retryBaseDelayMs ?? 250;

	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await adapter(resolved);
		} catch (err) {
			lastError = err;
			const retryable = err instanceof InferenceError && err.status !== undefined && RETRYABLE_STATUS.has(err.status);
			if (!retryable || attempt === attempts - 1) throw err;
			await sleep(baseDelayMs * 2 ** attempt);
		}
	}
	throw lastError;
}
