import { describe, it, expect, vi } from 'vitest';
import { runInference } from './client';
import { InferenceError } from './types';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

const noopSleep = async () => {};

describe('anthropic', () => {
	it('sends the right request shape and normalizes the response', async () => {
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://api.anthropic.com/v1/messages');
			expect(init?.headers).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' });
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({ model: 'claude-sonnet-4-5', system: 'be concise', max_tokens: 2048 });
			expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
			return jsonResponse(200, {
				content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'there' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 10, output_tokens: 5 },
			});
		});

		const result = await runInference({
			modelId: 'anthropic/claude-sonnet-4-5',
			apiKey: 'sk-ant-test',
			maxTokens: 2048,
			messages: [
				{ role: 'system', content: 'be concise' },
				{ role: 'user', content: 'hi' },
			],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result).toEqual({
			content: 'hello there',
			stopReason: 'end_turn',
			usage: { inputTokens: 10, outputTokens: 5 },
			provider: 'anthropic',
			model: 'claude-sonnet-4-5',
		});
	});

	it('throws InferenceError with the API error message on a non-2xx response', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { message: 'invalid x-api-key' } }));

		await expect(
			runInference({
				modelId: 'anthropic/claude-sonnet-4-5',
				apiKey: 'bad-key',
				messages: [{ role: 'user', content: 'hi' }],
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepImpl: noopSleep,
			}),
		).rejects.toMatchObject({ message: 'invalid x-api-key', provider: 'anthropic', status: 401 });
	});
});

describe('openai', () => {
	it('sends the right request shape and normalizes the response', async () => {
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(url).toBe('https://api.openai.com/v1/chat/completions');
			expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-oai-test' });
			const body = JSON.parse(init!.body as string);
			expect(body.model).toBe('gpt-5');
			expect(body.messages).toEqual([
				{ role: 'system', content: 'be concise' },
				{ role: 'user', content: 'hi' },
			]);
			return jsonResponse(200, {
				choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 12, completion_tokens: 6 },
			});
		});

		const result = await runInference({
			modelId: 'openai/gpt-5',
			apiKey: 'sk-oai-test',
			messages: [
				{ role: 'system', content: 'be concise' },
				{ role: 'user', content: 'hi' },
			],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result).toEqual({
			content: 'hello there',
			stopReason: 'stop',
			usage: { inputTokens: 12, outputTokens: 6 },
			provider: 'openai',
			model: 'gpt-5',
		});
	});
});

describe('google-ai-studio', () => {
	it('sends the right request shape (systemInstruction, model role) and normalizes the response', async () => {
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(url.toString()).toBe(
				'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=goog-test',
			);
			const body = JSON.parse(init!.body as string);
			expect(body.systemInstruction).toEqual({ parts: [{ text: 'be concise' }] });
			expect(body.contents).toEqual([
				{ role: 'user', parts: [{ text: 'hi' }] },
				{ role: 'model', parts: [{ text: 'hello' }] },
			]);
			return jsonResponse(200, {
				candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
				usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
			});
		});

		const result = await runInference({
			modelId: 'google-ai-studio/gemini-2.5-pro',
			apiKey: 'goog-test',
			messages: [
				{ role: 'system', content: 'be concise' },
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'hello' },
			],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result).toEqual({
			content: 'ok',
			stopReason: 'STOP',
			usage: { inputTokens: 8, outputTokens: 2 },
			provider: 'google-ai-studio',
			model: 'gemini-2.5-pro',
		});
	});
});

describe('retry behavior', () => {
	it('retries once on a 429 and succeeds', async () => {
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls++;
			if (calls === 1) return jsonResponse(429, { error: { message: 'rate limited' } });
			return jsonResponse(200, {
				content: [{ type: 'text', text: 'ok' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		});
		const sleepImpl = vi.fn(noopSleep);

		const result = await runInference({
			modelId: 'anthropic/claude-sonnet-4-5',
			apiKey: 'sk-ant-test',
			messages: [{ role: 'user', content: 'hi' }],
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleepImpl,
		});

		expect(result.content).toBe('ok');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleepImpl).toHaveBeenCalledTimes(1);
	});

	it('throws after exhausting retry attempts on repeated 500s', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(500, { error: { message: 'server error' } }));

		await expect(
			runInference({
				modelId: 'anthropic/claude-sonnet-4-5',
				apiKey: 'sk-ant-test',
				messages: [{ role: 'user', content: 'hi' }],
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepImpl: noopSleep,
				retryAttempts: 3,
			}),
		).rejects.toMatchObject({ status: 500 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('does not retry a non-retryable 400', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { message: 'bad request' } }));

		await expect(
			runInference({
				modelId: 'anthropic/claude-sonnet-4-5',
				apiKey: 'sk-ant-test',
				messages: [{ role: 'user', content: 'hi' }],
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepImpl: noopSleep,
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe('model id parsing', () => {
	it('rejects an unsupported provider without calling fetch', async () => {
		const fetchImpl = vi.fn();
		await expect(
			runInference({
				modelId: 'cerebras/some-model',
				apiKey: 'x',
				messages: [{ role: 'user', content: 'hi' }],
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(InferenceError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejects a modelId with no provider prefix', async () => {
		await expect(
			runInference({ modelId: 'gpt-5', apiKey: 'x', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toBeInstanceOf(InferenceError);
	});

	it('splits only on the first slash, for providers whose model names contain one', async () => {
		const fetchImpl = vi.fn(async (url: string | URL) => {
			expect(url.toString()).toContain('/models/openai%2Fgpt-oss-120b-maas:generateContent');
			return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
		});

		await runInference({
			modelId: 'google-ai-studio/openai/gpt-oss-120b-maas',
			apiKey: 'goog-test',
			messages: [{ role: 'user', content: 'hi' }],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
