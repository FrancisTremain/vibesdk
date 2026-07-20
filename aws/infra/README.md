# aws/infra — vibesdk's AWS infrastructure

Terraform for vibesdk's own AWS foundation: the Phase 3 actor-model
spike (test whether Lambda-per-message rehydration latency is viable
before porting the real `CodeGeneratorAgent`) plus the six DynamoDB
tables and one S3 bucket backing every `aws/db-*`/`aws/auth-*`/
`aws/git-storage` package built so far — Phase 4's "stateless surface
port" from
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md).

This lives entirely inside vibesdk. It follows architectural patterns
established by a separate reference platform design (ABAC-style tagging,
cost-conscious Spot/on-demand defaults, the general shape of app hosting
on ECS/Lambda) but is not deployed onto or coupled to that platform's
infrastructure or Terraform state — this stack provisions and owns its
own AWS resources independently.

Self-contained: no VPC attachment, no shared ALB/ECS cluster. The Lambda
reaches DynamoDB and API Gateway Management over the AWS network
directly, so there's no networking dependency to stand up first.

## What's here

- `main.tf` — provider, backend, default tags.
- `dynamodb.tf` — the actor-spike tables: `vibesdk-actor-state`
  (per-session state, optimistic lock via `lock_version`) and
  `vibesdk-ws-connections` (`connectionId → sessionId` routing,
  `by-session` GSI).
- `dynamodb-app.tf` — the six application tables from
  [docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md):
  `vibesdk-identity`, `vibesdk-apps`, `vibesdk-auth-flows`,
  `vibesdk-model-config`, `vibesdk-audit-log`,
  `vibesdk-system-settings`. Every attribute/GSI/TTL config is checked
  against what the shipped `aws/db-*` store code actually writes, not
  transcribed from the schema doc's paper design (which drifted from
  the real code in a few places while those packages were built —
  notably, the identity table's `by-provider` GSI is designed in the
  doc but no shipped code writes the attributes it'd need, so it's
  omitted here).
- `s3.tf` — `vibesdk-git-storage-<account-id>`, the single bucket
  `aws/git-storage`'s `S3FS` needs (versioning off, public access
  blocked, SSE-S3 encryption).
- `lambda.tf` — IAM role scoped to the actor-spike tables plus
  `execute-api:ManageConnections`, the Lambda function resource, its log
  group.
- `apigateway.tf` — WebSocket API wired to the Lambda across
  `$connect`/`$disconnect`/`$default`.
- `auth-api.tf` — the auth slice of the real API surface: IAM role
  scoped to just the identity/auth-flows/audit-log tables, the
  `aws/auth-api-lambda` Lambda function, and an API Gateway HTTP API
  (v2) with one explicit route per `(method, path)` the handler's
  `routeKey` switch matches (kept in sync with that file — see its
  comment) rather than a single `ANY /{proxy+}` catch-all, so an
  unmatched request 404s at API Gateway instead of reaching the
  Lambda. `$default`-stage, `auto_deploy = true`, matching the
  actor-spike API's shape.
- `apps-api.tf` — same shape for `aws/apps-api-lambda`'s app listing/
  detail/favorite/star/visibility/delete routes. Its IAM role gets
  read/write on the apps table but read-only on identity/auth-flows,
  since this Lambda only validates tokens, never mutates a session.
- `variables.tf` / `outputs.tf`.

Lambda source for the actor-spike lives in
[`../actor-spike/`](../actor-spike/); for the auth API, in
[`../auth-api-lambda/`](../auth-api-lambda/); for the apps API, in
[`../apps-api-lambda/`](../apps-api-lambda/). All three packages'
`*_package_s3_bucket`/`*_package_s3_key` variables have no defaults —
there's no CI pipeline yet to build and upload any of them; set them
once one exists. `jwt_secret` also has no default and is marked
`sensitive` — see its description in `variables.tf` for why it
shouldn't be passed as a literal Terraform variable in a real apply
(source it from SSM Parameter Store / Secrets Manager once a secrets
pipeline exists instead).

## Status

Not applied. Not run through `terraform validate`/`fmt` — no `terraform`
binary was available in the environment this was written in. Needs both,
plus human review of the IAM/network-facing pieces (especially
`jwt_secret` sourcing), before any apply. Nothing in this directory yet
stands up a Lambda/API Gateway surface for the analytics/model-config
tables' real callers (`aws/db-analytics`, `aws/db-model-config`) — those
don't have a Lambda handler ported yet, only auth and apps do.

## What this measures

The open question this spike exists to answer: can a Lambda invoked
fresh per WebSocket message — no standing worker process holding session
state in memory — rehydrate a realistic session's state from
DynamoDB/S3, apply a mutation, and respond within an acceptable latency
budget? That's the actor model's biggest unresolved risk in the design
doc, and this is the smallest thing that can test it in isolation before
porting `CodeGeneratorAgent` for real.
