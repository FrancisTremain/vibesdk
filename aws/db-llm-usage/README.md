# db-llm-usage

AWS-native replacement for [`worker/services/analytics/AiGatewayAnalyticsService.ts`](../../worker/services/analytics/AiGatewayAnalyticsService.ts),
which powers `GET /api/user/:id/analytics` and `GET /api/agent/:id/analytics`
by querying Cloudflare AI Gateway's GraphQL Analytics API directly.

## Why this isn't a port

There is no AWS equivalent to Cloudflare AI Gateway's analytics — no
managed service tracks per-request token/cost/error data for `aws/llm-client`'s
Anthropic/OpenAI/Google AI Studio calls. Rather than leave the two routes
unbuilt or fake their response shape, this package tracks usage itself:
one DynamoDB item per `runInference` call, written by `aws/agent-runtime`
immediately after each call (`aws/agent-runtime/src/usage.ts`), aggregated
here into the same response shape the original returned.

## Schema

Single table, `pk`/`sk` + a `gsi1` index:

- `pk = user#<userId>`, `sk = <isoTimestamp>#<uuid>` — one item per call, queried by user.
- `gsi1pk = session#<sessionId>`, `gsi1sk = <isoTimestamp>#<uuid>` — same items, queried by agent session.

`ttl` set 90 days out — usage detail beyond that isn't worth the storage cost.

## Not tracked (the original's AI Gateway query had these; this doesn't)

- **Cache hit/miss** — `aws/llm-client` has no caching layer to report on.
- **Per-hour activity buckets, query response time** — not computed from
  raw per-request rows in the original either; specific to AI Gateway's
  own aggregation. Reporting fabricated values for either would be worse
  than omitting them.

## Cost estimation

`src/pricing.ts` is a manually maintained USD-per-million-token table —
not sourced from a live pricing API (none of the three provider SDKs this
repo uses expose one). A model not listed contributes 0 to `totalCost`
rather than a guessed number.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is a minimal fake supporting `PutCommand` and
`QueryCommand` (base table + `gsi1`, with `>=` cutoff filtering for the
time-range queries) — the only two commands this package's `UsageStore`
issues. 5 tests.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Wired in: `aws/agent-runtime` writes via `src/usage.ts` (best-effort,
failures logged and swallowed — must never turn a successful or already-
failed LLM call into a harder failure), `aws/user-api-lambda` reads via
`GET /api/user/{id}/analytics` and `GET /api/agent/{id}/analytics`. Not
yet applied to real infrastructure — see `aws/infra/dynamodb-llm-usage.tf`.
