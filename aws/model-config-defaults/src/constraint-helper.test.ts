import { describe, expect, it } from 'vitest';
import { AIModels } from './config.types';
import { getFilteredModelsForAgent, validateAgentConstraints } from './constraint-helper';

describe('validateAgentConstraints', () => {
	it('is always valid for an action with no constraint entry', () => {
		expect(validateAgentConstraints('blueprint', AIModels.GEMINI_2_5_PRO)).toEqual({ valid: true, constraintEnabled: false });
	});

	it('rejects a disallowed model for a constrained action', () => {
		const result = validateAgentConstraints('templateSelection', AIModels.GEMINI_2_5_PRO);
		expect(result.valid).toBe(false);
		expect(result.constraintEnabled).toBe(true);
		expect(result.allowedModels).toBeDefined();
	});

	it('accepts an allowed model for a constrained action', () => {
		const result = validateAgentConstraints('templateSelection', AIModels.GEMINI_2_5_FLASH_LITE);
		expect(result.valid).toBe(true);
	});
});

describe('getFilteredModelsForAgent', () => {
	it('returns the unfiltered list for an unconstrained action', () => {
		const models = [AIModels.GEMINI_2_5_PRO, AIModels.GEMINI_2_5_FLASH];
		expect(getFilteredModelsForAgent('blueprint', models)).toEqual(models);
	});

	it('intersects available models with the constraint for a constrained action', () => {
		const models = [AIModels.GEMINI_2_5_PRO, AIModels.GEMINI_2_5_FLASH_LITE];
		expect(getFilteredModelsForAgent('templateSelection', models)).toEqual([AIModels.GEMINI_2_5_FLASH_LITE]);
	});
});
