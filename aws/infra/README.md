# aws/infra — vibesdk's AWS infrastructure

Terraform for vibesdk's own AWS foundation: the Phase 3 actor-model
spike (test whether Lambda-per-message rehydration latency is viable
before porting the real `CodeGeneratorAgent`), the six DynamoDB tables
and one S3 bucket backing every `aws/db-*`/`aws/auth-*`/`aws/git-storage`
package built so far (Phase 4's "stateless surface port"), three real
API Gateway + Lambda surfaces (auth, apps, user/stats/model-config),
and the ECS infrastructure shape for Phase 5's sandbox port, per
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md).

This lives entirely inside vibesdk. It follows architectural patterns
established by a separate reference platform design (ABAC-style tagging,
cost-conscious Spot/on-demand defaults, the general shape of app hosting
on ECS/Lambda) but is not deployed onto or coupled to that platform's
infrastructure or Terraform state — this stack provisions and owns its
own AWS resources independently.

Everything except `sandbox.tf` is VPC-free by design: Lambda reaches
DynamoDB and API Gateway Management over the AWS network directly, no
networking dependency to stand up first. `sandbox.tf` is the one
exception — ECS Fargate tasks need a VPC to run in, so that file
provisions its own minimal one (see below for why it's public-subnet-only,
no NAT).

## What's here

- `main.tf` — provider, backend, default tags. `var.aws_region`
  (default `ap-southeast-2`) drives the provider region; the S3 backend
  block's region is kept literal in sync with it since Terraform backend
  configuration can't reference variables.
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
- `user-api.tf` — same shape for `aws/user-api-lambda`'s stats,
  model-provider-listing, and model-config CRUD routes. Read-only on
  apps/identity/auth-flows, read/write on model-config. Also carries
  `PLATFORM_MODEL_PROVIDERS` and per-provider `*_API_KEY` environment
  variables that `aws/model-config-defaults`' BYOK-platform-key check
  reads.
- `sandbox.tf` — ECS infrastructure shape for Phase 5's on-demand
  sandbox tasks (Fargate Spot, launched fresh via `RunTask`, no
  standing pool): a minimal VPC, an ALB for preview traffic, security
  groups, the ECS cluster/capacity provider, IAM roles, and a task
  definition referencing a placeholder image. **Infrastructure shape
  only** — no control-plane server exists to run in that task yet (see
  [`../sandbox-contract/`](../sandbox-contract/)'s README for why
  that's a real design task, not a port, and what this shape is for in
  the meantime). One deliberate deviation from the design doc's literal
  "small Spot task replacing a NAT Gateway" cost-model line: sandbox
  tasks run directly in **public** subnets with security-group-restricted
  inbound (ALB only), avoiding NAT entirely — cheaper and simpler than
  either a real NAT Gateway (~$32/mo floor, breaks the <$100/mo budget
  on its own) or a hand-rolled NAT-replacement task (a Fargate task's
  ENI is ephemeral, a poor fit for a stable route-table target). See
  that file's header comment for the full reasoning.
- `variables.tf` / `outputs.tf`.

Lambda source for the actor-spike lives in
[`../actor-spike/`](../actor-spike/); for the auth API, in
[`../auth-api-lambda/`](../auth-api-lambda/); for the apps API, in
[`../apps-api-lambda/`](../apps-api-lambda/); for the user API, in
[`../user-api-lambda/`](../user-api-lambda/). All four packages'
`*_package_s3_bucket`/`*_package_s3_key` variables have no defaults —
there's no CI pipeline yet to build and upload any of them; set them
once one exists. `jwt_secret` also has no default and is marked
`sensitive` — see its description in `variables.tf` for why it
shouldn't be passed as a literal Terraform variable in a real apply
(source it from SSM Parameter Store / Secrets Manager once a secrets
pipeline exists instead). `sandbox_task_image` and
`sandbox_alb_certificate_arn` also have no defaults, for the reasons
described in `sandbox.tf` above.

## Status

Not applied. Not run through `terraform validate`/`fmt` — no `terraform`
binary was available in the environment this was written in. Needs both,
plus human review of the IAM/network-facing pieces (especially
`jwt_secret` sourcing), before any apply. Every one of the six
application DynamoDB tables now has at least one real Lambda caller,
including the audit-log table's security-event path (wired into the
auth Lambda) and the model-config table's full CRUD surface (wired
into the user Lambda via `aws/model-config-defaults`). `sandbox.tf` is
infrastructure shape only, per above — not wired to any real control
plane.

## What this measures

The open question this spike exists to answer: can a Lambda invoked
fresh per WebSocket message — no standing worker process holding session
state in memory — rehydrate a realistic session's state from
DynamoDB/S3, apply a mutation, and respond within an acceptable latency
budget? That's the actor model's biggest unresolved risk in the design
doc, and this is the smallest thing that can test it in isolation before
porting `CodeGeneratorAgent` for real.
