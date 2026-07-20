# user-api-lambda

API Gateway HTTP API (v2) Lambda handler for user stats
(`worker/api/routes/statsRoutes.ts`) and custom model-provider listing
(`worker/api/routes/modelProviderRoutes.ts`), wired to
[`vibesdk-db-analytics`](../db-analytics/),
[`vibesdk-db-model-config`](../db-model-config/), and
[`vibesdk-auth-orchestration`](../auth-orchestration/) (token
validation only). Same `event.routeKey`-switch shape as the other
`aws/*-api-lambda` packages.

## Deliberately narrow — two real reasons, not scope-trimming for its own sake

1. **Model-config CRUD isn't here.** `worker/api/controllers/modelConfig/controller.ts`
   validates every `agentAction` against `AGENT_CONFIG`
   (`worker/agents/inferutils/config.ts`) and merges stored overrides
   with per-action defaults/constraints pulled from it on nearly every
   endpoint. `aws/db-model-config`'s README already documents this as
   explicitly not ported — that package is storage only, with no
   `AGENT_CONFIG` dependency. Porting the model-config HTTP routes
   faithfully would mean also porting or duplicating that large,
   product-specific static config into a separate Lambda deployment —
   a materially different, larger task than every other handler in
   this migration, not attempted here.
2. **Provider create/update/delete return 503, matching the live
   product.** `ModelProvidersController.createProvider`/
   `updateProvider`/`deleteProvider` are themselves disabled right now
   in `worker/api/controllers/modelProviders/controller.ts` — each
   returns 503 "Custom model providers are temporarily disabled..."
   unconditionally, before ever touching the database. This handler
   mirrors that exact current behavior for API-contract parity rather
   than reviving a feature the live product has turned off. If/when
   it's re-enabled upstream, `vibesdk-db-model-config`'s
   `ModelProviderStore` already has full `createProvider`/
   `updateProvider`/`deleteProvider` support (tested, see that
   package's README) — wiring it into these three routes is
   mechanical whenever that happens.
3. `testProvider`'s live-connection-test path (ad-hoc `baseUrl`/`apiKey`
   testing, not the disabled stored-provider path) makes a real
   network call to an LLM provider — out of scope for a storage-layer
   Lambda, not ported at all (not even a stub).

## What's ported

`GET /api/stats` (`AnalyticsStore.getUserStats`), `GET /api/stats/activity`
(`AnalyticsStore.getUserActivityTimeline`, 20 most recent),
`GET /api/user/providers` (active providers only, matching the
original's `.filter(p => p.isActive)`), `GET /api/user/providers/{id}`.

## Testing

6 tests, no real AWS or DynamoDB: the `/stats` auth gate, zeroed stats
and an empty activity timeline for a fresh user, provider listing
filtering out a deactivated provider, fetching a single provider by
id, and all three disabled-provider-mutation routes returning 503.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> user-api-lambda.zip
```

## Status

Not deployed. Every route tested against the fake DynamoDB client; never
run against real API Gateway or DynamoDB. Terraform for its API Gateway
HTTP API + Lambda + scoped IAM role is in
[`../infra/user-api.tf`](../infra/user-api.tf), also not applied.
