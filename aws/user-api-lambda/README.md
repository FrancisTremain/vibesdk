# user-api-lambda

API Gateway HTTP API (v2) Lambda handler for user stats
(`worker/api/routes/statsRoutes.ts`), custom model-provider listing
(`worker/api/routes/modelProviderRoutes.ts`), and model-config CRUD
(`worker/api/routes/modelConfigRoutes.ts`), wired to
[`vibesdk-db-analytics`](../db-analytics/),
[`vibesdk-db-model-config`](../db-model-config/),
[`vibesdk-model-config-defaults`](../model-config-defaults/), and
[`vibesdk-auth-orchestration`](../auth-orchestration/) (token
validation only). Same `event.routeKey`-switch shape as the other
`aws/*-api-lambda` packages.

## Model-config CRUD

`worker/api/controllers/modelConfig/controller.ts` validates every
`agentAction` against `AGENT_CONFIG`
(`worker/agents/inferutils/config.ts`) and merges stored overrides with
per-action defaults/constraints pulled from it. `aws/db-model-config`
never ported that merge logic (storage only, by design). This handler
gets it from `vibesdk-model-config-defaults` instead — a duplicated
snapshot of `AGENT_CONFIG`/`AGENT_CONSTRAINTS` plus the pure
merge/constraint/BYOK-platform-key-check logic, built specifically to
unblock these routes. See that package's README for why duplication
(not a shared import from `worker/`) was the right call for now.

Ported: `GET /` (all agent actions, each merged+constrained),
`GET /{agentAction}`, `PUT /{agentAction}` (validates the model against
both the agent action's constraint and platform-key availability,
exactly like the original's two-stage check — the model must be
*allowed* for that action AND the deployment must actually have a
platform key configured for its provider), `DELETE /{agentAction}`
(reset one to default), `POST /reset-all`.

Not ported: `testModelConfig`'s live-network-call path (out of scope
for a storage-layer Lambda), and the BYOK-user-key half of model access
validation — see `model-config-defaults`'s README on why that's
already a no-op stub in the live product today, not something this
port simplified away.

## Model-provider listing

1. **Only listing is live.** `ModelProvidersController.createProvider`/
   `updateProvider`/`deleteProvider` are themselves disabled right now
   in the original — each returns 503 "Custom model providers are
   temporarily disabled..." unconditionally, before ever touching the
   database. This handler mirrors that exact current behavior for
   API-contract parity rather than reviving a feature the live product
   has turned off. `vibesdk-db-model-config`'s `ModelProviderStore`
   already has full CRUD support (tested) — wiring it into these three
   routes is mechanical whenever upstream re-enables the feature.
2. `testProvider`'s live-connection-test path (ad-hoc `baseUrl`/`apiKey`
   testing) makes a real network call to an LLM provider — out of scope
   for a storage-layer Lambda, not ported at all.

## Harness credentials (the auth.json branching path)

`GET/PUT/DELETE /api/user/credentials` let a user switch their generation
harness sessions (`aws/agent-harness`) from the platform's workspace-scoped
Anthropic API key to their own uploaded Claude Code OAuth credentials
(the `claudeAiOauth` blob from a `.credentials.json` export). `PUT`
encrypts the uploaded JSON with KMS (`aws_kms_key.user_credentials`,
[`../infra/user-credentials.tf`](../infra/user-credentials.tf)) before
writing it to `vibesdk-db-identity`'s `HarnessCredentialsStore` — this
Lambda's IAM role has `kms:Encrypt` only, never `kms:Decrypt`, so once
written it can't read the plaintext back either. Decryption happens
inside the harness Fargate task itself at session-start time, via its
own IAM role — see `aws/agent-harness/src/credentials-client.ts` and
`user-credentials.tf`'s module comment for the full reasoning (mainly:
never put a live account credential on the harness control plane's
plain-HTTP channel).

## What's ported

`GET /api/stats` (`AnalyticsStore.getUserStats`), `GET /api/stats/activity`
(`AnalyticsStore.getUserActivityTimeline`, 20 most recent),
`GET /api/user/providers` (active providers only, matching the
original's `.filter(p => p.isActive)`), `GET /api/user/providers/{id}`,
and the model-config CRUD routes above.

## Testing

13 tests, no real AWS or DynamoDB: the `/stats` auth gate, zeroed stats
and an empty activity timeline for a fresh user, provider listing
filtering out a deactivated provider, fetching a single provider by
id, all three disabled-provider-mutation routes returning 503, listing
all agent-action configs defaulted for a fresh user, an invalid
agent-action name rejected, a full update-then-read-back round trip for
an allowed model, a constraint-violating model rejected with 400, a
model with no configured platform key rejected with 403, delete then
404-on-repeat-delete, and reset-all reporting the count. `process.env.GOOGLE_AI_STUDIO_API_KEY`
is set in the model-config test suite's `beforeEach` to exercise the
platform-key-present path realistically rather than mocking it away.

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
