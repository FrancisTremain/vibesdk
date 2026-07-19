# AWS Migration Design: vibesdk on Dark Factory infrastructure

## Status

Design proposal. No infrastructure has been provisioned and no application
code has been ported. This document exists to get the architecture agreed
before any Terraform apply or code change.

## Goal

Re-host vibesdk — currently a Cloudflare-native app (Workers, Durable
Objects, D1, Containers, Workers-for-Platforms) — on AWS, using
`vibe-platform`'s existing Dark Factory infrastructure (VPC, shared ALB,
ECS Fargate blue/green, the `app-blue-green` Terraform module, DynamoDB,
SSM, WAF, CodeArtifact) as the hosting substrate rather than building new
AWS infrastructure from scratch.

## What vibesdk actually uses today

| Concern | Cloudflare primitive | Where |
|---|---|---|
| HTTP/WS entrypoint | Worker | `worker/index.ts` |
| Control-plane relational data (users, apps, api keys, sessions, model configs) | D1 (SQLite) via Drizzle | `worker/database/services/*` |
| Per-session agent runtime (state machine, conversation, generated files) | Durable Object (`CodeGeneratorAgent`), built on the CF `agents` SDK for connection/hibernation handling | `worker/agents/core/*` |
| Per-session git history | isomorphic-git, filesystem adapter backed directly by the *DO's own* transactional SQLite storage (chunked rows, 1.8MB/chunk) — **not** D1 | `worker/agents/git/fs-adapter.ts` |
| Rate limiting | Durable Object (`DORateLimitStore`) + CF `ratelimit` bindings | `worker/services/rate-limit/DORateLimitStore.ts` |
| User API-key vault | Durable Object (`UserSecretsStore`), session-bound key hierarchy (VMK/SK), CF Sandbox SDK not used here | `worker/services/secrets/UserSecretsStore.ts` |
| Sandboxed code execution | CF Containers via `@cloudflare/sandbox`, itself a DO (`UserAppSandboxService`) proxying to container ports | `worker/services/sandbox/*` |
| Deploying a generated app | Dynamically-written `wrangler.jsonc` + Workers-for-Platforms `dispatch_namespaces`, deployed via CF API | `worker/services/deployer/*` |
| Blob storage | R2 | scattered |
| KV | Workers KV | scattered |
| LLM inference for code fixing / eval | Workers AI, Browser Rendering bindings | assistants/codeDebugger etc. |

Two persistence layers matter, and they are **not** the same thing:

1. **D1** — ordinary relational control-plane data. Maps cleanly onto
   Aurora Serverless v2 (Postgres), since Drizzle already abstracts the
   query layer; this is a dialect swap plus a migration rewrite, not a
   redesign.
2. **DO-local SQLite** — per-agent-instance transactional storage
   (agent state blob, git object chunks, secrets vault). This is
   Durable-Object-specific: it gets its consistency guarantees from the
   DO being a single-threaded actor with storage colocated in the same
   transaction boundary. This is the part with no AWS equivalent and is
   the actual crux of the migration.

## What vibe-platform already provides that we should reuse as-is

- VPC, private subnets, shared ALB with host-based routing, ACM/TLS —
  `environments/core`.
- ECS cluster (Fargate + Fargate Spot).
- `modules/app-blue-green` — ECR + ECS service + task def + blue/green
  target groups + CodeDeploy canary + ABAC task role. This is the right
  shape for vibesdk's own control-plane service (the ported Worker) and,
  separately, is *already the right shape* for hosting each user-generated
  app.
- SSM Parameter Store for config/secrets, DynamoDB on-demand tables for
  operational metadata, CodeArtifact for npm/pip package caching, WAF.
- The governor/token-budget pattern (Phase 4) is a reusable template for
  vibesdk's own per-user rate limiting, even though vibe-platform's
  instance of it is scoped to the platform's own agent spend.

What vibe-platform does **not** provide, and vibesdk needs new: a fast,
programmatic per-generated-app provisioning path. vibe-platform's model
is "onboarding a new app = a human/agent commits
`environments/apps/<name>/main.tf` and runs `terraform apply`" — that's
fine for a handful of long-lived platform apps, but vibesdk creates and
tears down a new "app" (or previews one) on the order of every user
session. A Terraform apply per user click is not viable. This is called
out explicitly as an open design question below.

## Component mapping and migration plan

| vibesdk component | AWS target | Effort/risk |
|---|---|---|
| Worker entrypoint | Containerize (Node/Hono or similar), run as an ECS Fargate service behind the shared ALB via `app-blue-green` | Medium — mechanical, ALB supports WebSocket passthrough natively |
| D1 + Drizzle | Aurora Serverless v2 Postgres + Drizzle pg driver | Medium — schema/migration rewrite (10 migrations), query-level dialect issues (SQLite-specific functions, `INSERT OR REPLACE`, etc.) |
| R2 | S3 | Low |
| KV | DynamoDB on-demand | Low |
| `DORateLimitStore` | DynamoDB conditional-update token bucket (same pattern as vibe-platform's governor) | Low-Medium |
| `UserSecretsStore` | Same crypto (VMK/SK hierarchy, AES-GCM/XChaCha20-Poly1305) unchanged; storage moves to DynamoDB or Aurora; consider KMS-wrapping the top-level key | Medium — crypto logic ports directly, session-affinity for the WS-bound vault session needs a story (see actor-model section) |
| CF Sandbox / Containers (`UserAppSandboxService`) | Ephemeral ECS Fargate tasks, one per active session, reachable via ALB path/host routing for preview URLs | Medium-High — CF's sandbox SDK handles port exposure/proxying/token validation for free; on ECS this needs to be built (a thin router service mapping session ID → task IP:port, or an ALB rule per active preview) |
| Deployer (`wrangler.jsonc` + Workers-for-Platforms dispatch) | Programmatic per-app provisioning against the `app-blue-green` module — **not** literal `terraform apply` per app (see open question below) | High — biggest divergence from how vibe-platform currently onboards apps |
| `CodeGeneratorAgent` (Durable Object actor + state machine) | No direct analog. See dedicated section below. | **High — this is the critical-path risk for the whole migration** |
| Git-per-session (isomorphic-git on DO SQLite) | Isomorphic-git unchanged; filesystem adapter re-targeted at Aurora (a `git_objects` table keyed by session ID, same chunking scheme) or S3 for large blobs + Aurora for refs/tree metadata | Medium |

## The actor-model gap (critical path)

A Durable Object gives vibesdk three guarantees for free, all bundled
into `CodeGeneratorAgent`:

1. **Single-threaded serialization** — every WebSocket message, tool
   call, and state mutation for a given session runs one-at-a-time, no
   locking code required.
2. **Colocated durable storage** — state mutations and their SQLite
   writes are in the same transactional boundary; a crash mid-mutation
   can't leave state and storage disagreeing.
3. **Hibernation and rehydration** — the DO can evict from memory between
   messages and come back with `state` restored, at effectively no cost,
   and CF's `agents` SDK handles WS reconnect/state-resync on top.

None of these exist natively in ECS/Lambda. Proposed replacement:

- **Compute**: a pool of long-lived ECS Fargate tasks ("session
  workers"), each capable of holding N active sessions in memory
  (similar to how a Node process can hold many objects). A lightweight
  router (could live in the ALB-fronted control-plane service) maps
  `sessionId → workerTaskId` and pins WebSocket connections there via
  ALB sticky sessions (or, more robustly, an explicit routing layer
  since ALB stickiness is cookie-based and WS wants connection-level
  pinning).
- **Serialization**: per-session mutation lock via a DynamoDB conditional
  write (`sessionId` as key, optimistic lock / row lock) or a Postgres
  advisory lock in Aurora — either enforces the DO's single-threaded
  guarantee explicitly instead of getting it for free.
- **Durability**: state blob + git object chunks persisted to Aurora
  (or DynamoDB for the state blob, Aurora/S3 for git objects) on every
  mutation, same shape as today's DO-SQLite writes, just an explicit
  write instead of an implicit one.
- **Rehydration**: on task restart or session migration, reload state
  from Aurora/DynamoDB before accepting the next message — this replaces
  DO hibernation. Reconnect-and-resync WS logic (currently handled by the
  CF `agents` SDK) needs to be reimplemented; this is a real chunk of new
  code, not a config change.

This is the single highest-risk, highest-effort piece of the whole
migration and should be prototyped before committing to the rest of the
plan (see Phase 3 below).

## Open design questions

1. **Per-generated-app provisioning speed.** vibe-platform's onboarding
   flow (commit Terraform, `apply`) is too slow for vibesdk's per-session
   deploy/preview flow. Candidate approaches:
   - Direct AWS SDK calls (not Terraform) from a provisioning service to
     spin up ECR push + ECS task def + service + ALB rule per generated
     app, with Terraform only describing the *shared* scaffolding
     (cluster, ALB, IAM roles) that provisioning calls into.
   - A shared multi-tenant "preview runner" fleet where generated apps
     run as processes/containers-within-a-task behind a single
     path-or-host router, avoiding one-ECS-service-per-app entirely for
     ephemeral previews, and only using the full `app-blue-green` module
     for apps the user explicitly "deploys" long-term.
   This needs a decision before Phase 4 (see below) starts.
2. **WebSocket session pinning mechanism** — ALB sticky sessions vs. a
   custom connection router. Affects the session-worker design directly.
3. **Git storage medium** — Aurora row-chunking (mirrors today's design,
   simplest port) vs. S3 for git objects with Aurora only for refs
   (cheaper at scale, more moving parts).
4. **Secrets vault session-affinity** — `UserSecretsStore`'s in-memory
   `VaultSession` (SK, encrypted VMK) currently lives in one DO's memory
   for the life of a session. On ECS this either needs the same
   session-worker pinning as the main agent, or a separate small stateful
   service just for the vault.
5. **Cost model** — DO/D1/R2/KV usage-based pricing vs. always-on Aurora
   Serverless v2 + Fargate. Worth a rough cost comparison before Phase 2
   starts, since "cost is king" is a stated vibe-platform constraint.

## Phased plan

1. **Design doc (this document)** — reviewed and agreed before any
   infra or code changes.
2. **Infra scaffolding** — add `environments/apps/vibesdk` in
   vibe-platform, reusing `environments/core`'s VPC/ALB/ECS
   cluster/`app-blue-green` module. Provisions the hosting shell only:
   no vibesdk-specific compute or data yet.
3. **Actor-model spike** — prototype the session-worker replacement for
   `CodeGeneratorAgent` (routing, locking, Aurora/DynamoDB-backed state,
   reconnect/resync) in isolation, before porting the full agent. This
   is the de-risking step; if it doesn't work well, it changes the rest
   of the plan.
4. **Stateless surface port** — D1→Aurora (Drizzle dialect swap, 10
   migrations), R2→S3, KV→DynamoDB, containerize the Worker entrypoint,
   deploy it as an ECS service via `app-blue-green`.
5. **Sandbox + deploy port** — resolve open question #1, replace
   `UserAppSandboxService` with ECS-task-backed sandboxes, replace the
   wrangler/dispatch deployer with the AWS provisioning path decided in
   Phase 3/#1.
6. **Cutover** — once parity is verified end-to-end in a non-prod
   environment, plan the actual traffic cutover (DNS, data migration for
   existing D1/DO data if any needs to carry over).

Phases 2 and 3 can run in parallel; Phase 4 depends on neither blocking
the other, but Phase 5 depends on the outcome of Phase 3.
