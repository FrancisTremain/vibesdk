/**
 * Manually maintained USD-per-million-token pricing, used only to
 * compute an approximate `totalCost` for the analytics endpoints.
 * Not sourced from a live pricing API (none of the three provider
 * SDKs this repo uses expose one) -- update alongside
 * aws/agent-runtime's AGENT_MODEL_ID default when provider pricing
 * changes. A model not listed here contributes 0 to totalCost rather
 * than a guessed number.
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
	'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
	'anthropic/claude-opus-4-1': { input: 15, output: 75 },
	'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
	'openai/gpt-4o': { input: 2.5, output: 10 },
	'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
	'google/gemini-2.5-pro': { input: 1.25, output: 10 },
	'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
	const rate = PRICING_PER_MILLION_TOKENS[model];
	if (!rate) return 0;
	return (tokensIn * rate.input + tokensOut * rate.output) / 1_000_000;
}
