import { describe, expect, it } from 'vitest';
import { AGENT_CONFIG } from './config';
import { AIModels } from './config.types';
import { applyConstraintsWithFallback, mergeWithDefaults, resolveModelConfig, validateModel } from './merge';

describe('mergeWithDefaults', () => {
	it('returns the default config unmarked when no user override exists', () => {
		const merged = mergeWithDefaults(null, 'blueprint');
		expect(merged.isUserOverride).toBe(false);
		expect(merged.name).toBe(AGENT_CONFIG.blueprint.name);
	});

	it('merges a partial user override on top of defaults', () => {
		const merged = mergeWithDefaults(
			{ id: 'cfg-1', modelName: null, maxTokens: 12345, temperature: null, reasoningEffort: null, fallbackModel: null },
			'blueprint',
		);
		expect(merged.isUserOverride).toBe(true);
		expect(merged.max_tokens).toBe(12345);
		expect(merged.name).toBe(AGENT_CONFIG.blueprint.name); // falls back to default
		expect(merged.userConfigId).toBe('cfg-1');
	});

	it('an invalid stored model name falls back to the default rather than propagating garbage', () => {
		const merged = mergeWithDefaults(
			{ id: 'cfg-1', modelName: 'not-a-real-model', maxTokens: null, temperature: null, reasoningEffort: null, fallbackModel: null },
			'blueprint',
		);
		expect(merged.name).toBe(AGENT_CONFIG.blueprint.name);
	});
});

describe('validateModel', () => {
	it('allows any model when no constraint exists for the action', () => {
		expect(validateModel('blueprint', AIModels.GEMINI_2_5_PRO, 'primary', 'throw')).toBe(true);
	});

	it('throws for a constrained action given a disallowed model', () => {
		expect(() => validateModel('templateSelection', AIModels.GEMINI_2_5_PRO, 'primary', 'throw')).toThrow(/not allowed/);
	});

	it('allows a constrained action given an allowed (lite) model', () => {
		expect(validateModel('templateSelection', AIModels.GEMINI_2_5_FLASH_LITE, 'primary', 'throw')).toBe(true);
	});

	it('with fallback strategy, returns false and warns instead of throwing', () => {
		const warnings: string[] = [];
		const result = validateModel('templateSelection', AIModels.GEMINI_2_5_PRO, 'primary', 'fallback', (m) => warnings.push(m));
		expect(result).toBe(false);
		expect(warnings).toHaveLength(1);
	});
});

describe('applyConstraintsWithFallback / resolveModelConfig', () => {
	it('falls back to the full default when a user override violates its constraint', () => {
		const merged = mergeWithDefaults(
			{ id: 'cfg-1', modelName: AIModels.GEMINI_2_5_PRO, maxTokens: null, temperature: null, reasoningEffort: null, fallbackModel: null },
			'templateSelection',
		);
		const constrained = applyConstraintsWithFallback(merged, 'templateSelection');
		expect(constrained.isUserOverride).toBe(false);
		expect(constrained.name).toBe(AGENT_CONFIG.templateSelection.name);
	});

	it('resolveModelConfig composes merge + constrain in one call', () => {
		const resolved = resolveModelConfig(null, 'blueprint');
		expect(resolved.isUserOverride).toBe(false);
		expect(resolved.name).toBe(AGENT_CONFIG.blueprint.name);
	});

	it('leaves a compliant user override untouched', () => {
		const resolved = resolveModelConfig(
			{ id: 'cfg-1', modelName: AIModels.GEMINI_2_5_FLASH_LITE, maxTokens: null, temperature: null, reasoningEffort: null, fallbackModel: null },
			'templateSelection',
		);
		expect(resolved.isUserOverride).toBe(true);
		expect(resolved.name).toBe(AIModels.GEMINI_2_5_FLASH_LITE);
	});
});
