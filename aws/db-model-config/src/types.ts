/**
 * Field shapes ported from worker/database/schema.ts's
 * user_model_configs/user_model_providers tables.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ProviderOverride = 'cloudflare' | 'direct';

export interface UserModelConfig {
	id: string;
	userId: string;
	agentActionName: string;
	modelName: string | null;
	maxTokens: number | null;
	temperature: number | null;
	reasoningEffort: ReasoningEffort | null;
	providerOverride: ProviderOverride | null;
	fallbackModel: string | null;
	isActive: boolean;
	createdAt: number;
	updatedAt: number;
}

export type UpsertModelConfigData = Partial<
	Omit<UserModelConfig, 'id' | 'userId' | 'agentActionName' | 'createdAt' | 'updatedAt' | 'isActive'>
>;

export interface UserModelProvider {
	id: string;
	userId: string;
	name: string;
	baseUrl: string;
	secretId: string | null;
	isActive: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface CreateProviderData {
	name: string;
	baseUrl: string;
	secretId: string;
}

export interface UpdateProviderData {
	name?: string;
	baseUrl?: string;
	secretId?: string | null;
	isActive?: boolean;
}
