# model-config-defaults

Duplicated snapshot of `worker/agents/inferutils/config.ts` +
`config.types.ts` (`AGENT_CONFIG`/`AGENT_CONSTRAINTS`, the AI model
catalog) and the pure merge/constraint/BYOK-access logic from
`worker/database/services/ModelConfigService.ts` and
`worker/api/controllers/modelConfig/`. Exists so
`aws/user-api-lambda`'s model-config CRUD routes can validate and merge
model configuration the same way the original does, without needing
real per-user D1 access to `AGENT_CONFIG` at request time.

## Why a duplicate, not an import — and why that's a deliberate, revisitable tradeoff

Every other `aws/*` package in this migration ports a *service*:
something with a clear boundary, tested against its own inputs and
outputs, that doesn't need the rest of the `worker/` tree to make
sense. `AGENT_CONFIG` is different — it's a large, product-specific
static config (the AI model catalog, per-agent-action defaults,
per-agent-action model constraints) that the main `worker/` codebase
owns and updates directly (`CLAUDE.md` even documents "Change LLM
Model for Operation: Edit `/worker/agents/inferutils/config.ts`" as a
common task). Two ways to give the AWS side access to it:

1. **Extract it into a package both `worker/` and this migration
   import** — no drift, but means restructuring production `worker/`
   import paths for a migration that isn't deploying yet. Every other
   change in this migration has been purely additive (new `aws/*`
   packages, zero edits to `worker/`); this would be the first
   exception.
2. **Duplicate a snapshot** — fast, zero risk to production code, same
   pattern this migration already uses for small shared files (see
   `fake-dynamo.ts`'s copies across packages). Costs sync effort: if
   `worker/agents/inferutils/config.ts` changes, this package's copy
   needs a matching update or the two diverge.

Duplication is the right call *now*, while nothing depends on staying
in sync yet (no deployment, no real traffic). The real extraction
(option 1) is the right move during Phase 6 cutover prep, when
`worker/` itself starts getting decommissioned and drift risk stops
mattering because there's only one copy left standing.

## What changed in the copy, and what didn't

**One substantive change** (`config.ts`): the original reads
`env.PLATFORM_MODEL_PROVIDERS` via Cloudflare's `cloudflare:workers`
module-level `env` singleton — a Workers-only import with no Node/Lambda
equivalent. Replaced with a plain `process.env` read.
`config.types.ts` (the model catalog, 340+ lines of data) and
`constraint-helper.ts` are copied unchanged — pure data/logic, no
Cloudflare dependency in the originals either.

**One deliberate simplification** (`byok-helper.ts`): the original's
`getUserProviderStatus` is already a stub in the live codebase — it
returns `hasValidKey: false` for every provider unconditionally, real
per-user BYOK-key-presence checking isn't implemented there either.
Since every status it can produce has `hasValidKey: false`,
`validateModelAccessForEnvironment`'s `hasUserKey` branch can never be
true — the function's actual behavior today is exactly
`hasPlatformKey`, nothing else. This port makes that explicit (drops
the stub, keeps the platform-key check) rather than faithfully copying
a function that always returns the same input regardless of its
argument.

**Pure functions, not class methods** (`merge.ts`): `mergeWithDefaults`/
`applyConstraintsWithFallback`/`validateModel` were private methods on
`ModelConfigService` (a `BaseService` subclass with D1 access). Ported
as standalone functions taking a `StoredUserModelConfig | null` — same
logic, no class/D1 dependency to carry along, since
`aws/db-model-config`'s `ModelConfigStore` already does the storage
half.

## Testing

22 tests, pure logic, no AWS/DynamoDB involved: merge-with-defaults
(including an invalid stored model name falling back rather than
propagating garbage), constraint validation's throw/fallback strategies,
`resolveModelConfig`'s merge+constrain composition, the BYOK
platform-key-only environment check, and the model-catalog constraint
helpers.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Used by [`aws/user-api-lambda`](../user-api-lambda/)'s model-config CRUD
routes. Not deployed.
