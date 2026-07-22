/** Shared model/credential resolution for ./llm.ts and ./generation.ts. */

export const MODEL_ID = process.env.AGENT_MODEL_ID ?? 'anthropic/claude-sonnet-4-5';

function apiKeyEnvVarFor(provider: string): string {
	return `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}

/** Throws with a clear message (surfaced to the client as an `error`
 *  response by handler.ts) if the configured model's provider has no
 *  API key set. */
export function resolveApiKey(modelId: string): string {
	const provider = modelId.split('/')[0];
	if (!provider) throw new Error(`Invalid modelId: ${modelId}`);

	const envVar = apiKeyEnvVarFor(provider);
	const apiKey = process.env[envVar];
	if (!apiKey) {
		throw new Error(`No API key configured for provider "${provider}" (expected ${envVar})`);
	}
	return apiKey;
}
