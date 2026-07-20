# actor-spike

Phase 3 deliverable from `docs/aws-migration-design.md`: the smallest
possible test of the design's biggest open risk — can a Lambda invoked
fresh per WebSocket message, with no standing worker process holding
session state in memory, rehydrate state from DynamoDB, apply a
mutation, and respond within an acceptable latency budget?

This is **not** a port of `CodeGeneratorAgent`. It implements the
plumbing only: connection routing, the per-session optimistic lock, a
state read/write round trip, and latency measurement — with a
placeholder mutation (increment a counter) standing in for real agent
work. Once this answers the latency question, the real actor logic gets
built on top of the same pattern.

## What it does

Three WebSocket routes, one handler (`src/handler.ts`):

- `$connect` — records `connectionId -> sessionId` in the
  `vibesdk-ws-connections` DynamoDB table (query param `sessionId`
  required).
- `$disconnect` — removes that record.
- `$default` (any message) — looks up the session for this connection,
  loads (or initializes) its state from `vibesdk-actor-state` under an
  optimistic lock (`lock_version`, matching the design doc's "DynamoDB
  conditional write" decision), applies a placeholder mutation, persists
  it, and pushes an ack back over the same connection with a
  `latency_ms` breakdown (`total`, `dynamo_read`, `rehydrate`, `persist`).

Every invocation also logs a structured `actor_spike_message_handled`
line to CloudWatch with the same numbers, for aggregating latency
distributions across many test messages.

## Build

```
npm install
npm run typecheck
npm run build      # -> dist/handler.js
npm run package     # -> actor-spike.zip, upload target for the Lambda
```

`@aws-sdk/*` is marked external in the esbuild bundle — Lambda's Node 20
runtime ships the AWS SDK v3 already, no need to bundle it.

## Infra

Terraform lives in `vibe-platform`'s
`platform/infra/environments/apps/vibesdk/` — see that directory's
README for status (not yet applied, needs `terraform validate` and human
review). It expects this package uploaded to S3 and wired via
`lambda_package_s3_bucket`/`lambda_package_s3_key` — no CI pipeline
exists yet to automate that upload.

## What "done" looks like for this spike

Enough `actor_spike_message_handled` latency samples, across a range of
artificially-sized state items (small vs. large, to approximate real
session state), to answer: is Lambda-per-message rehydration fast enough
to be viable for the real agent, or does the design need to change
(e.g. opportunistic execution-environment-reuse caching, a smaller
per-message state footprint, or reconsidering Lambda for this tier)?
That answer feeds back into `docs/aws-migration-design.md`.
