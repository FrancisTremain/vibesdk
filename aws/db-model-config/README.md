# db-model-config

DynamoDB port of `ModelProvidersService` (full) and the storage layer of
`ModelConfigService` (partial — see below), against Table 4
(`vibesdk-model-config`) of
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md) —
designed there but not previously validated against real code, unlike
Table 1 (`aws/db-identity`) and Table 2 (`aws/db-apps`).

Ports [`worker/database/services/ModelProvidersService.ts`](../../worker/database/services/ModelProvidersService.ts)
and the CRUD half of
[`worker/database/services/ModelConfigService.ts`](../../worker/database/services/ModelConfigService.ts).

## What's not ported, and why

`ModelConfigService`'s merge-with-defaults and constraint-validation
logic (`mergeWithDefaults`, `applyConstraintsWithFallback`,
`validateModel`) is **not ported**. It imports `AGENT_CONFIG`/
`AGENT_CONSTRAINTS` from `worker/agents/inferutils/config` and a
constraint helper from `worker/api/controllers/modelConfig/` —
application/business logic that lives in the main codebase, not a
storage concern, and not something this package should duplicate (that
would drift from the real source over time as those defaults/constraints
change). What's ported is the layer underneath: read/write the raw
stored config. Merging with `AGENT_CONFIG` defaults and constraint
enforcement stay the caller's job — same scoping choice as leaving
screenshot-URL signing to the caller in `aws/db-apps`.

## Two different key shapes, and why

Both `UserModelConfig` and `UserModelProvider` are always addressed by
`(userId, key)` together at every real call site — unlike sessions or
API keys (see `aws/db-identity`), nothing here needed a bare-ID lookup
item, since the ID is never the only thing a caller has.

- **Model configs** are keyed directly by `agentActionName` — it's
  already a stable, per-user-unique key (`getUserModelConfig(userId,
  agentActionName)` is the only real access pattern), so no separate
  lookup item is needed at all.
- **Providers** have two legitimate lookup axes — `getProvider` by ID
  (used by update/delete/toggle) and `getProviderByName` by name (with
  a real uniqueness constraint on `(userId, name)`) — so the provider
  item is keyed by ID, with a `TransactWriteItems`-backed name-lookup
  item alongside it, same pattern as the identity table's username
  handling in `aws/db-identity`. Renaming a provider releases the old
  name lookup and claims the new one atomically; both are tested
  directly, including the rejection of a name collision.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is copied from `aws/db-identity` unchanged — same
`TransactWriteItems` semantics needed here. 16 tests cover config
upsert/list/delete/reset (including that a second upsert fully replaces
rather than merges, matching the original's UPDATE semantics) and
provider CRUD including name-uniqueness enforcement, per-user isolation,
and rename with lookup-item reassignment.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
