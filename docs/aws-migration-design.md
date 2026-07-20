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

1. **D1** — ordinary relational control-plane data (users, apps, api
   keys, sessions, model configs). Access patterns here are key-lookup
   shaped (by user, by app, by session, by api key), not join-heavy, so
   this maps onto DynamoDB single-table design rather than a relational
   engine — see decision below. This is not a dialect swap; it's a
   query-layer rewrite (Drizzle's relational query API goes away, access
   patterns must be enumerated up front).
2. **DO-local SQLite** — per-agent-instance transactional storage
   (agent state blob, git object chunks, secrets vault). This is
   Durable-Object-specific: it gets its consistency guarantees from the
   DO being a single-threaded actor with storage colocated in the same
   transaction boundary. This is the part with no AWS equivalent and is
   the actual crux of the migration.

**Decision: no Aurora.** Given vibe-platform's "cost is king" constraint,
this design does not introduce a relational database. Control-plane data
goes to DynamoDB on-demand (same table class vibe-platform already uses
for `governor`/`parked_tasks`); git objects and other large blobs go to
S3. The tradeoff is explicit: anything join-shaped (admin reporting,
cross-entity analytics) needs either an access pattern designed into the
table up front (GSIs) or a separate export path (e.g. periodic S3 export
queried via Athena) — there is no ad hoc query escape hatch once this is
built. If a genuine join-heavy requirement shows up during Phase 4 that
can't be reasonably served by DynamoDB access patterns, that's the
trigger to revisit this decision, not a default fallback to Aurora.

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
| Worker entrypoint | Containerize (Node/Hono or similar), run as an ECS Fargate (Spot) service behind the shared ALB via `app-blue-green` | Medium — mechanical, ALB supports WebSocket passthrough natively |
| D1 + Drizzle | DynamoDB on-demand, single-table design keyed by entity access patterns | Medium-High — no relational engine, so this is a query-layer rewrite, not a dialect swap (see decision above) |
| R2 | S3 | Low |
| KV | DynamoDB on-demand | Low |
| `DORateLimitStore` | DynamoDB conditional-update token bucket (same pattern as vibe-platform's governor) | Low-Medium |
| `UserSecretsStore` | Same crypto (VMK/SK hierarchy, AES-GCM/XChaCha20-Poly1305) unchanged; storage moves to DynamoDB; consider KMS-wrapping the top-level key | Medium — crypto logic ports directly; piggybacks on the session-worker pinning boundary (see decision in actor-model section) rather than a separate stateful service |
| CF Sandbox / Containers (`UserAppSandboxService`) | Ephemeral ECS Fargate (Spot) tasks drawn from the two-tier warm pool, reachable via ALB path/host routing for preview URLs | Medium-High — CF's sandbox SDK handles port exposure/proxying/token validation for free; on ECS this needs to be built (a thin router service mapping session ID → task IP:port, or an ALB rule per active preview). See warm-pool decision below. |
| Deployer (`wrangler.jsonc` + Workers-for-Platforms dispatch) | Programmatic per-app provisioning against the `app-blue-green` module — **not** literal `terraform apply` per app (see open question below) | High — biggest divergence from how vibe-platform currently onboards apps |
| `CodeGeneratorAgent` (Durable Object actor + state machine) | No direct analog. See dedicated section below. | **High — this is the critical-path risk for the whole migration** |
| Git-per-session (isomorphic-git on DO SQLite) | Isomorphic-git unchanged; filesystem adapter re-targeted at S3 only (chunked objects + manifest, no DynamoDB) | Medium — must reach full feature parity with today (see decision 3) |

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

- **Compute**: a pool of long-lived ECS Fargate Spot tasks ("session
  workers"), each capable of holding N active sessions in memory
  (similar to how a Node process can hold many objects). A lightweight
  router (could live in the ALB-fronted control-plane service) maps
  `sessionId → workerTaskId` via an explicit routing table (DynamoDB),
  not ALB sticky sessions — see decision below.
- **Serialization**: per-session mutation lock via a DynamoDB conditional
  write (`sessionId` as key, optimistic lock) — enforces the DO's
  single-threaded guarantee explicitly instead of getting it for free.
- **Durability**: state blob persisted to DynamoDB, git object chunks to
  S3, on every mutation — same shape as today's DO-SQLite writes, just an
  explicit write instead of an implicit one.
- **Rehydration**: on task restart, session migration, or Spot
  interruption, reload state from DynamoDB/S3 before accepting the next
  message — this replaces DO hibernation. Reconnect-and-resync WS logic
  (currently handled by the CF `agents` SDK) needs to be reimplemented;
  this is a real chunk of new code, not a config change.

**Decision: Fargate Spot, 100% — no on-demand baseline.** This matches
vibe-platform's own stated constraint ("Fargate Spot over EC2") and is
close to free correctness-wise: the design above already externalizes
all session state to DynamoDB/S3 so a worker can rehydrate on any node,
which is exactly what's needed to survive a Spot interruption (2-minute
reclaim notice) — on notice, stop accepting new messages for the
sessions on that task, let in-flight mutations finish and persist, and
let the router reassign those sessions to another warm worker.

Accepted downsides of skipping an on-demand floor, since they're real and
worth stating rather than glossing over:
- Spot capacity shortages can be *correlated* across an AZ/instance
  family during a demand crunch — replacement tasks can fail to launch
  fleet-wide, not just one at a time, which with zero on-demand floor
  means a window where no warm slot is obtainable at all, not just a
  slower one.
- Interruptions cluster in practice; a simultaneous wave of reclaims can
  produce a rehydration stampede against DynamoDB/S3 and the router at
  once.
- No AWS SLA on Spot availability, and shortages tend to correlate with
  high-demand periods — which may coincide with peak product usage.

Mitigations adopted instead of an on-demand floor: diversify the Spot
request across multiple instance types/AZs (capacity-optimized
allocation strategy) to decorrelate interruptions, and act on Fargate's
rebalance-recommendation signal proactively (it fires before the hard
2-minute reclaim notice, giving the router a head start on reassignment).
Treat "add a small on-demand floor" as the reactive fix if production
monitoring shows real user-facing incidents from this — not something to
pre-build speculatively.

This is the single highest-risk, highest-effort piece of the whole
migration and should be prototyped before committing to the rest of the
plan (see Phase 3 below).

## Design decisions (resolved)

1. **Per-generated-app provisioning speed — warm blue/green pool, kept
   warm by UI activity, not blind capacity.** vibe-platform's onboarding
   flow (commit Terraform, `apply`) is too slow for vibesdk's per-session
   deploy/preview flow, and sizing a generic always-warm pool for
   anticipated concurrency wastes capacity that sits idle. Decision
   is two tiers:
   - **Tier 1 — generic warm pool.** A small pool of pre-warmed, generic
     sandbox/session-worker tasks running on Spot capacity ("blue" and
     "green"), sized only for brand-new or cold-evicted sessions to claim
     instantly — no image pull, no cold boot. Replenished asynchronously
     in the background to maintain a target warm count. The blue/green
     split does double duty as the base-image rollout mechanism (drain
     and repoint new claims to the freshly warmed pool, retire the old
     one) without disrupting live sessions — same conceptual pattern as
     `app-blue-green`'s canary deploys, applied to a warm capacity pool
     instead of a versioned service swap.
   - **Tier 2 — activity-based keep-warm for live sessions.** Once a
     session claims a slot (e.g. the user clicks "preview"), the client
     sends a lightweight heartbeat — driven by the Page Visibility API,
     so it only fires while the preview UI is actually visible/focused —
     that resets an idle-eviction timer on that session's task. As long
     as the UI stays active, the task stays warm and pinned, no
     reprovisioning needed on reconnect. When the tab is backgrounded or
     closed, the heartbeat stops; after a grace period with no heartbeat,
     the task is released back to Tier 1 (or torn down) since state is
     already durable in DynamoDB/S3. Re-establishing a session after
     eviction is the same rehydration path as a Spot reclaim (see
     actor-model section) — just triggered by inactivity instead of
     infrastructure churn.

   Terraform still only describes the shared scaffolding (cluster, ALB,
   IAM roles, warm-pool ASG/capacity provider config); claiming a slot,
   heartbeat handling, and eviction are runtime AWS SDK calls from the
   provisioning/routing service, not a Terraform apply. The full
   `app-blue-green` module (ECR, CodeDeploy canary, ALB listener rules)
   is reserved for apps a user explicitly "deploys" long-term, not
   ephemeral previews.
2. **WebSocket session pinning — explicit router, not ALB stickiness.**
   ALB sticky sessions are cookie-based and don't give the connection-
   level pinning a long-lived WS needs. Decision: a `sessionId →
   workerTaskId` lookup table in DynamoDB, consulted by the routing layer
   on every new connection and updated on rebalance/Spot reclaim.
3. **Git storage medium — S3 only, no DynamoDB in the git path.** The
   original two-store split (S3 for blobs, DynamoDB for refs) isn't
   needed: S3 alone already gives strong read-after-write consistency on
   both puts and overwrites, and prefix-delimited `ListObjectsV2` covers
   `readdir` — the two things a DynamoDB refs table would otherwise be
   there for. The filesystem adapter isomorphic-git needs is re-targeted
   entirely at S3, mirroring today's design: each file's chunks (same
   1.8MB chunking scheme) as S3 objects under a path prefix, with a small
   manifest object per path holding what chunk_index 0 holds today
   (parent_path, is_dir, size, mtime). This is a straight port of the
   existing adapter's storage backend, not a redesign of its logic.

   Feature parity with today is a hard requirement, not a nice-to-have:
   full commit history, `GitVersionControl.commit()/reset()/log()/show()`,
   and full clone protocol support (rebase-on-template) all need to work
   identically post-migration.

   Known tradeoff: isomorphic-git does many small reads during tree
   walks, and S3 request latency/cost per object is higher than a local
   DO-SQLite row read. Mitigation: since Tier 2 of decision 1 already
   keeps an active session's task warm and pinned in memory for the
   duration of UI activity, that same task can hold an in-memory LRU
   cache of recently read git objects — S3 round-trips only happen on a
   cold read or on rehydration after eviction, not on every git
   operation during an active session.
4. **Secrets vault session-affinity — piggyback on session-worker
   pinning.** `UserSecretsStore`'s in-memory `VaultSession` (SK,
   encrypted VMK) needs the same connection-level pinning as the main
   agent for the life of a session. Decision: reuse the session-worker
   router from #2 rather than standing up a separate stateful service —
   one fewer moving part, and the trust boundary (in-memory-only key
   material, never persisted) is preserved either way since it rides on
   the same worker process, not a shared store.
5. **Cost model — Spot only, no on-demand floor, no Aurora.** Resolved
   in favor of 100% Fargate Spot for session workers/sandboxes (see
   actor-model section, including the accepted downsides and mitigations
   written out there) and DynamoDB/S3 over Aurora for all persistence
   (see decision above). A concrete cost estimate (expected concurrent
   sessions × Tier-1 warm-pool size × Spot task-hours × DynamoDB/S3
   usage) should still be run before Phase 2 starts to size the Tier-1
   pool, but the architecture-level question — no always-on relational
   database, no always-on compute fleet — is settled.

   **On-demand-floor cost, quantified.** Using the sandbox spec vibesdk
   already runs today (4 vCPU / 8 GB, per `wrangler.jsonc`'s `containers`
   block) against Fargate list pricing (Linux/x86, us-east-1 reference —
   ap-southeast-2 runs ~10-20% higher, reprice before committing):
   a sandbox-class task costs roughly $144/task-month on-demand vs. $50
   on Spot (~65% off) — about $94/task-month delta, or ~$187-$937/month
   for a 2-10 task floor. Lighter session-worker tasks (1 vCPU / 2 GB)
   are proportionally cheaper (~$36 vs. ~$13/task-month). This is why
   Spot-only was chosen over adding a floor: on-demand costs ~3x Spot for
   the same reserved capacity.

   **The more important structural point:** this on-demand-vs-Spot delta
   is *secondary* to a bigger difference between the two platforms.
   Cloudflare bills Durable Objects and Containers by active duration —
   a hibernating DO or an idle-but-provisioned Container costs ~nothing.
   Fargate has no equivalent: a task (Spot or on-demand) bills its full
   vCPU/GB rate for every second it's provisioned and warm, whether or
   not it's handling a request that second. So the real cost lever in
   this design isn't the Spot/on-demand choice — it's **minimizing
   aggregate warm-task-hours** across both tiers (a tight Tier-2
   idle-eviction grace period, a small Tier-1 floor, genuine scale-to-zero
   when nothing's active). A generous grace period or an oversized Tier-1
   pool could plausibly cost more in aggregate than the Spot/on-demand
   choice ever would. Getting a real head-to-head number against current
   spend requires pulling vibesdk's actual Cloudflare usage (DO
   duration-GB-s, D1 reads/writes, Containers vCPU-seconds, R2
   storage/egress) from the account's Analytics & Billing — not available
   from this repo alone, and needed before Phase 2 cost sign-off.

## Remaining open questions

- **Current Cloudflare spend baseline** (decision 5) — pull actual usage
  from the vibesdk Cloudflare account (DO duration-GB-s, D1 reads/writes,
  Containers vCPU-seconds, R2 storage/egress) to get a real head-to-head
  cost comparison against the AWS estimate above. This is the single
  highest-value missing input for the whole cost model and isn't
  obtainable from the codebase — needs dashboard/billing access.
- Instance-type/AZ diversification plan for the Spot fleet (decision 5)
  — needed to make the "decorrelate interruptions" mitigation concrete;
  should come from historical Spot interruption rates for candidate
  instance families, gathered during Phase 3.
- Idle-eviction grace period for Tier 2 keep-warm (decision 1) — how
  long to hold a session's task warm after the UI heartbeat stops before
  releasing it back to Tier 1. Too short defeats the point (users
  briefly switching tabs trigger cold rehydration); too long wastes Spot
  capacity on abandoned tabs. Needs a real number from usage data or a
  Phase 3 trial, not a guess.
- Target size for the Tier-1 generic warm pool (decision 1) — depends on
  the rate of brand-new/cold-evicted session arrivals, which should come
  from current vibesdk production metrics rather than a guess.

## Phased plan

1. **Design doc (this document)** — reviewed and agreed before any
   infra or code changes.
2. **Infra scaffolding** — add `environments/apps/vibesdk` in
   vibe-platform, reusing `environments/core`'s VPC/ALB/ECS
   cluster/`app-blue-green` module. Provisions the hosting shell only:
   no vibesdk-specific compute or data yet.
3. **Actor-model spike** — prototype the session-worker replacement for
   `CodeGeneratorAgent` (routing, locking, DynamoDB/S3-backed state,
   Spot-interruption handling, reconnect/resync) in isolation, before
   porting the full agent. This is the de-risking step; if it doesn't
   work well, it changes the rest of the plan. Also where the remaining
   open questions (Spot diversification plan, idle-eviction grace
   period, Tier-1 pool sizing) get real numbers.
4. **Stateless surface port** — D1→DynamoDB (query-layer rewrite, 10
   migrations' worth of schema to re-derive as access patterns), R2→S3,
   KV→DynamoDB, containerize the Worker entrypoint, deploy it as an ECS
   Fargate Spot service via `app-blue-green`.
5. **Sandbox + deploy port** — stand up the two-tier warm pool
   (decision 1: generic Tier-1 pool plus UI-heartbeat-driven Tier-2
   keep-warm), replace `UserAppSandboxService` with ECS-task-backed
   sandboxes drawn from it, replace the wrangler/dispatch deployer with
   the AWS provisioning path from decision 1, and port the git
   fs-adapter to S3-only storage (decision 3) with parity verified
   against today's `GitVersionControl` behavior.
6. **Cutover** — once parity is verified end-to-end in a non-prod
   environment, plan the actual traffic cutover (DNS, data migration for
   existing D1/DO data if any needs to carry over).

Phases 2 and 3 can run in parallel; Phase 4 depends on neither blocking
the other, but Phase 5 depends on the outcome of Phase 3.
