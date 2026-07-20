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
- `variables.tf` / `outputs.tf`.

Lambda source lives in [`../actor-spike/`](../actor-spike/) in this same
repo. `lambda_package_s3_bucket`/`lambda_package_s3_key` have no
defaults — there's no CI pipeline yet to build and upload the package;
set them once one exists.

## Status

Not applied. Not run through `terraform validate`/`fmt` — no `terraform`
binary was available in the environment this was written in. Needs both,
plus human review of the IAM/network-facing pieces, before any apply.
`lambda.tf`'s IAM role and `apigateway.tf`'s routing cover the
actor-spike only; nothing in this directory yet stands up a Lambda/API
Gateway surface for the six application tables' real callers (the
`aws/db-*`/`aws/auth-*` packages) -- that's the next infra piece once
`worker/index.ts`'s routing itself gets ported to API Gateway + Lambda.

## What this measures

The open question this spike exists to answer: can a Lambda invoked
fresh per WebSocket message — no standing worker process holding session
state in memory — rehydrate a realistic session's state from
DynamoDB/S3, apply a mutation, and respond within an acceptable latency
budget? That's the actor model's biggest unresolved risk in the design
doc, and this is the smallest thing that can test it in isolation before
porting `CodeGeneratorAgent` for real.
