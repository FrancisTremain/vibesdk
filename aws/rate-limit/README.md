# rate-limit

DynamoDB-backed rate limiter replacing `DORateLimitStore`, per
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md)'s
component mapping. Port of
[`worker/services/rate-limit/DORateLimitStore.ts`](../../worker/services/rate-limit/DORateLimitStore.ts) —
same bucketed sliding-window algorithm, same result shape.

## What changed in the port, and why

The original holds one Durable Object per rate-limit key, with all of
that key's buckets in a single in-memory `Map`, persisted as one blob,
swept periodically by a manual `cleanup()`. This version uses one
DynamoDB item per `(key, bucketStart)` instead, for two reasons:

1. The DO's single-threaded guarantee made read-Map-then-write-Map safe
   under concurrent calls for free. Nothing here provides that
   automatically (the same actor-model gap as the rest of this
   migration) — bucket increments use DynamoDB's atomic `ADD` instead,
   which needs no read-modify-write round trip or lock.
2. One blob per key means every increment rewrites the entire key's
   history, unbounded growth for a hot key. Per-bucket items avoid that
   and get automatic expiry via DynamoDB TTL, replacing the manual
   `cleanup()` sweep entirely.

**Not ported:** `resetLimit()` with no key (the original's "clear every
bucket for every key, globally" mode) — no caller in the codebase uses
it, and it doesn't map onto DynamoDB's pay-per-request model without a
full table scan. `resetLimit(key)`, the shape actually used, is ported
as-is.

See the module-level comment in `src/dynamo-rate-limiter.ts` for the
full reasoning.

## Testing without real DynamoDB

No local DynamoDB (DynamoDB Local, LocalStack) was available in the
environment this was written in. `src/fake-dynamo.ts` is a small
in-memory stand-in — not a general UpdateExpression parser, it only
recognizes the exact expression `DynamoRateLimiter` sends, matching that
one call site rather than emulating DynamoDB generally. 11 tests cover
main/burst/daily limits (individually and in precedence order), window
rollover, UTC-calendar-day alignment, key isolation, and `resetLimit`,
using `vitest`'s fake timers to control window boundaries deterministically.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Wired into `aws/apps-api-lambda`'s `GET /api/apps/public` (the
`vibesdk-rate-limits` DynamoDB table, see `aws/infra/
dynamodb-rate-limit.tf`), matching the original's
`enforcePublicAppsRateLimit` config (120 req/60s, 40 req/10s burst).
Not yet wired into the global API rate limit or auth rate limit paths
(`RateLimitService.enforceGlobalApiLimit`/`enforceAuthRateLimit`) --
those would need their own call sites in `aws/auth-api-lambda`/
`aws/user-api-lambda` plus a decision on where a "global" per-request
limiter belongs when there's no single entry Lambda for all routes.
