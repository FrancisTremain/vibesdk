export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface InferenceUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface InferenceResponse {
	content: string;
	stopReason: string;
	usage: InferenceUsage;
	provider: string;
	model: string;
}

export interface InferenceRequest {
	/** `provider/model-name`, e.g. `anthropic/claude-sonnet-4-5` -- aws/model-config-defaults's id convention. */
	modelId: string;
	apiKey: string;
	messages: ChatMessage[];
	maxTokens?: number;
	temperature?: number;
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests, to avoid real delays on the retry path; defaults to a real `setTimeout` sleep. */
	sleepImpl?: (ms: number) => Promise<void>;
	retryAttempts?: number;
	retryBaseDelayMs?: number;
}

/** A single resolved provider call -- `InferenceRequest` plus the parsed provider/model and defaulted fetch/sleep implementations. */
export interface ResolvedRequest extends Omit<InferenceRequest, 'modelId' | 'fetchImpl' | 'sleepImpl'> {
	provider: string;
	model: string;
	fetchImpl: typeof fetch;
}

export class InferenceError extends Error {
	constructor(
		message: string,
		public readonly provider: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'InferenceError';
	}
}

export type ProviderAdapter = (request: ResolvedRequest) => Promise<InferenceResponse>;
