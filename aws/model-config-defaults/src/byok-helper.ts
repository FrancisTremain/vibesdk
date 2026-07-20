/**
 * Port of the subset of worker/api/controllers/modelConfig/byokHelper.ts
 * that `validateModelAccessForEnvironment` actually needs.
 *
 * Not ported: `getUserProviderStatus` and `getByokModels`. Reading the
 * original closely: `getUserProviderStatus` is already a stub in the
 * live codebase today -- it returns `hasValidKey: false` for every
 * provider unconditionally (real per-user BYOK-key-presence checking
 * isn't implemented there either). Since every status it can produce
 * has `hasValidKey: false`, the `hasUserKey` branch in
 * `validateModelAccessForEnvironment` can never be true -- the
 * function's real behavior today is exactly `hasPlatformKey`, nothing
 * else. This port makes that explicit rather than faithfully copying a
 * stub that always returns the same thing.
 *
 * `getPlatformEnabledProviders` reads `env.PLATFORM_MODEL_PROVIDERS` /
 * `<PROVIDER>_API_KEY` -- both plain environment variable reads in the
 * original too (no Cloudflare-specific API), just via `Env` instead of
 * `process.env`.
 */

export function getPlatformEnabledProviders(env: Record<string, string | undefined>): string[] {
	const platformModelProviders = env.PLATFORM_MODEL_PROVIDERS;
	if (platformModelProviders) {
		return platformModelProviders.split(',').map((p) => p.trim());
	}

	const enabledProviders: string[] = [];
	const providerList = ['anthropic', 'openai', 'google-ai-studio', 'cerebras', 'groq'];

	for (const provider of providerList) {
		const providerKeyString = provider.toUpperCase().replaceAll('-', '_');
		const apiKey = env[`${providerKeyString}_API_KEY`];

		if (
			apiKey &&
			apiKey.trim() !== '' &&
			apiKey.trim().toLowerCase() !== 'default' &&
			apiKey.trim().toLowerCase() !== 'none' &&
			apiKey.trim().length >= 10
		) {
			enabledProviders.push(provider);
		}
	}

	return enabledProviders;
}

export function getProviderFromModel(model: string): string {
	if (model.includes('/')) {
		return model.split('/')[0]!;
	}
	return 'cloudflare';
}

/** Platform-key access only -- see module comment for why the
 *  user-BYOK-key branch is omitted rather than faithfully stubbed. */
export function validateModelAccessForEnvironment(model: string, env: Record<string, string | undefined>): boolean {
	const provider = getProviderFromModel(model);
	return getPlatformEnabledProviders(env).includes(provider);
}
