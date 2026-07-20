/**
 * Port of the merge/constraint-validation logic from
 * worker/database/services/ModelConfigService.ts
 * (`mergeWithDefaults`/`applyConstraintsWithFallback`/`validateModel`)
 * -- the "single source of truth for merge semantics" the original
 * calls it. Pure functions here instead of private class methods
 * (no `BaseService`/D1 dependency to hang them off), same logic.
 */

import { AGENT_CONFIG } from './config';
import type { AgentActionKey, ModelConfig, ReasoningEffort } from './config.types';
import { toAIModel } from './config.types';
import { validateAgentConstraints } from './constraint-helper';

export interface UserModelConfigWithMetadata extends ModelConfig {
	isUserOverride: boolean;
	userConfigId?: string;
}

/** The subset of aws/db-model-config's UserModelConfig this logic reads. */
export interface StoredUserModelConfig {
	id: string;
	modelName: string | null;
	maxTokens: number | null;
	temperature: number | null;
	reasoningEffort: ReasoningEffort | null;
	fallbackModel: string | null;
}

type ConstraintStrategy = 'throw' | 'fallback';

/** Throws (strategy 'throw') or returns false with a caller-supplied
 *  warn callback (strategy 'fallback') when a model violates its
 *  agent action's constraint. Returns true when no model was supplied
 *  or the constraint doesn't apply. */
export function validateModel(
	agentActionName: AgentActionKey,
	modelName: string | undefined,
	modelType: 'primary' | 'fallback',
	strategy: ConstraintStrategy,
	onFallbackWarn?: (message: string) => void,
): boolean {
	if (!modelName) return true;

	const constraintCheck = validateAgentConstraints(agentActionName, modelName);

	if (constraintCheck.constraintEnabled && !constraintCheck.valid) {
		const errorMsg =
			`${modelType === 'fallback' ? 'Fallback model' : 'Model'} '${modelName}' is not allowed for '${agentActionName}'. ` +
			`Allowed models: ${constraintCheck.allowedModels?.join(', ')}`;

		if (strategy === 'throw') {
			throw new Error(errorMsg);
		}
		onFallbackWarn?.(`${errorMsg} - falling back to default`);
		return false;
	}

	return true;
}

export function mergeWithDefaults(
	userConfig: StoredUserModelConfig | null,
	agentActionName: AgentActionKey,
): UserModelConfigWithMetadata {
	const defaultConfig = AGENT_CONFIG[agentActionName];

	if (!userConfig) {
		return { ...defaultConfig, isUserOverride: false };
	}

	return {
		name: toAIModel(userConfig.modelName) ?? defaultConfig.name,
		max_tokens: userConfig.maxTokens ?? defaultConfig.max_tokens,
		temperature: userConfig.temperature !== null ? userConfig.temperature : defaultConfig.temperature,
		reasoning_effort: (userConfig.reasoningEffort as ReasoningEffort | null) ?? defaultConfig.reasoning_effort,
		fallbackModel: toAIModel(userConfig.fallbackModel) ?? defaultConfig.fallbackModel,
		isUserOverride: true,
		userConfigId: userConfig.id,
	};
}

export function applyConstraintsWithFallback(
	mergedConfig: UserModelConfigWithMetadata,
	agentActionName: AgentActionKey,
	onFallbackWarn?: (message: string) => void,
): UserModelConfigWithMetadata {
	const defaultConfig = AGENT_CONFIG[agentActionName];

	if (!mergedConfig.isUserOverride) return mergedConfig;

	if (!validateModel(agentActionName, mergedConfig.name, 'primary', 'fallback', onFallbackWarn)) {
		return { ...defaultConfig, isUserOverride: false };
	}

	if (!validateModel(agentActionName, mergedConfig.fallbackModel, 'fallback', 'fallback', onFallbackWarn)) {
		return { ...mergedConfig, fallbackModel: defaultConfig.fallbackModel };
	}

	return mergedConfig;
}

/** Merge + constrain in one call -- what `getUserModelConfig`/
 *  `getUserModelConfigs` both do in the original. */
export function resolveModelConfig(
	userConfig: StoredUserModelConfig | null,
	agentActionName: AgentActionKey,
	onFallbackWarn?: (message: string) => void,
): UserModelConfigWithMetadata {
	return applyConstraintsWithFallback(mergeWithDefaults(userConfig, agentActionName), agentActionName, onFallbackWarn);
}
