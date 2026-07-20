# aws/infra — Phase 3 actor-model spike infrastructure

Terraform for the Phase 3 actor-model spike described in
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md) — not
the full migration, just what's needed to test whether Lambda-per-message
rehydration latency is viable before committing to porting the real
`CodeGeneratorAgent` onto it.

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
- `dynamodb.tf` — `vibesdk-actor-state` (per-session state, optimistic
  lock via `lock_version`) and `vibesdk-ws-connections`
  (`connectionId → sessionId` routing, `by-session` GSI).
- `lambda.tf` — IAM role scoped to just those two tables plus
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

## What this measures

The open question this spike exists to answer: can a Lambda invoked
fresh per WebSocket message — no standing worker process holding session
state in memory — rehydrate a realistic session's state from
DynamoDB/S3, apply a mutation, and respond within an acceptable latency
budget? That's the actor model's biggest unresolved risk in the design
doc, and this is the smallest thing that can test it in isolation before
porting `CodeGeneratorAgent` for real.
