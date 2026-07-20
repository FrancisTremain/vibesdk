import { describe, expect, it } from 'vitest';
import { getPlatformEnabledProviders, getProviderFromModel, validateModelAccessForEnvironment } from './byok-helper';

describe('getPlatformEnabledProviders', () => {
	it('uses PLATFORM_MODEL_PROVIDERS when set', () => {
		expect(getPlatformEnabledProviders({ PLATFORM_MODEL_PROVIDERS: 'openai, anthropic' })).toEqual(['openai', 'anthropic']);
	});

	it('falls back to per-provider API key env vars', () => {
		const providers = getPlatformEnabledProviders({ OPENAI_API_KEY: 'sk-1234567890', ANTHROPIC_API_KEY: '' });
		expect(providers).toEqual(['openai']);
	});

	it('rejects placeholder/short API key values', () => {
		expect(getPlatformEnabledProviders({ OPENAI_API_KEY: 'none' })).toEqual([]);
		expect(getPlatformEnabledProviders({ OPENAI_API_KEY: 'short' })).toEqual([]);
	});
});

describe('getProviderFromModel', () => {
	it('extracts the provider prefix', () => {
		expect(getProviderFromModel('google-ai-studio/gemini-2.5-pro')).toBe('google-ai-studio');
	});

	it('defaults to cloudflare for a bare model name', () => {
		expect(getProviderFromModel('disabled')).toBe('cloudflare');
	});
});

describe('validateModelAccessForEnvironment', () => {
	it('allows a model whose provider has a platform key', () => {
		expect(validateModelAccessForEnvironment('openai/gpt-5-mini', { OPENAI_API_KEY: 'sk-1234567890' })).toBe(true);
	});

	it('rejects a model whose provider has no platform key', () => {
		expect(validateModelAccessForEnvironment('openai/gpt-5-mini', {})).toBe(false);
	});
});
