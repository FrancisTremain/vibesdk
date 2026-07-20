# Technical Design: vibesdk on AWS

## Status

Design proposal. No infrastructure has been provisioned and no application
code has been ported. This document exists to get the architecture agreed
before any Terraform apply or code change.

Companion to
[docs/aws-migration-product-design.md](aws-migration-product-design.md),
which covers the "what" and "why" from a product perspective (user-facing
changes, scope decisions, success criteria). This document covers the
"how" — architecture, AWS component mapping, data model, cost model, and
the phased build plan. Where a decision here has product-facing
consequences (a dropped feature, an accepted UX tradeoff), the product
doc is the source of truth for that decision's rationale and status;
this doc implements it.

## Goal

Re-host vibesdk — currently a Cloudflare-native app (Workers, Durable
Objects, D1, Containers, Workers-for-Platforms) — on AWS. vibesdk
provisions and owns all of its own AWS infrastructure end to end, under
its own Terraform, inside this repo.

Some of the architectural patterns below (ABAC-style resource tagging,
the blue-green/canary shape for hosting apps on ECS, Spot-first
cost-conscious compute defaults, a DynamoDB-backed rate/budget-governor
pattern) were sourced as design inspiration from a separate reference
platform ("Dark Factory") this project was shown for context. **That
platform is reference material only — vibesdk does not depend on it,
provision into it, or share its Terraform state or already-applied AWS
resources.** Where earlier drafts of this doc assumed reuse of that
platform's live VPC/ALB/ECS cluster, that assumption has been removed;
vibesdk stands its own infrastructure up independently, following the
same patterns where they fit.

## Cost budget (hard constraint)

Target: **under $100/month**, lower if achievable, at low-to-moderate
usage. This is a hard constraint on the architecture, not a tuning target
applied after the fact — it ruled out an earlier draft of this design (see
"Rejected: standing warm-pool architecture" below) and is why the compute
model below is Lambda-first rather than reserved-capacity-first.

The one thing this budget cannot promise: cost that's flat regardless of
traffic. No architecture can serve real concurrent usage for a fixed fee —
cost fundamentally scales with concurrent active compute-seconds. What
this design *can* promise is that cost tracks usage closely (near-$0 at
near-$0 traffic, growing roughly linearly with it) instead of carrying a
fixed reserved-capacity floor that costs the same whether one person or
zero people are using the product. See the Cost model section below for
the worked numbers.

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
| Headless browser (console log / screenshot capture from generated apps) | CF `BROWSER` binding via `@cloudflare/puppeteer` | `worker/services/browser-capture/binding-client.ts` |
| LLM usage analytics/gateway (per-user connect-your-own-account for AI Gateway analytics + LLM proxying/caching) | CF AI Gateway, OAuth-connected per user (`aig.*` scopes) | `worker/services/analytics/AiGatewayAnalyticsService.ts`, `worker/services/oauth/cloudflare-connect.ts`, `worker/agents/inferutils/core.ts` |
| Frontend WebSocket client | `PartySocket` (CF Agents-SDK-oriented WS client, expects a DO-style single addressable endpoint per session) | `src/routes/chat/hooks/use-chat.ts`, `src/routes/chat/utils/websocket-helpers.ts`, and 6 other call sites |
| Deploy-generated-app-to-CF-Workers-for-Platforms UI flow (separate from the AI Gateway OAuth above — same `worker/services/deployer/*` CF API client, different feature) | CF API via `deployer/api/cloudflare-api.ts` | already covered by the Deployer row below; called out here only because it's a second, distinct CF surface easy to miss |

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

**Decision: no Aurora.** Given the cost budget above, this design does
not introduce a relational database. Control-plane data goes to DynamoDB
on-demand (pay-per-request billing, no idle floor); git objects and
other large blobs go to S3.
The tradeoff is explicit: anything join-shaped (admin reporting,
cross-entity analytics) needs either an access pattern designed into the
table up front (GSIs) or a separate export path (e.g. periodic S3 export
queried via Athena) — there is no ad hoc query escape hatch once this is
built. If a genuine join-heavy requirement shows up during Phase 4 that
can't be reasonably served by DynamoDB access patterns, that's the
trigger to revisit this decision, not a default fallback to Aurora.

## Rejected: standing warm-pool architecture (kept for context)

An earlier draft of this design ran session actors and sandboxes on a
pool of long-lived, always-warm ECS Fargate Spot tasks — a two-tier model
(a small generic warm pool for new sessions, plus per-session
UI-activity-driven keep-warm) intended to give instant preview claims
with no cold start. It's rejected under the cost budget above: even one
always-warm sandbox-class Fargate task (4 vCPU/8 GB, matching vibesdk's
current CF Container spec) costs ~$50/month on Spot — half the entire
budget for a single task, before any session-worker, control-plane, or
storage cost is counted. **Fargate bills reserved capacity by the second,
regardless of activity** — there is no Fargate equivalent of a Durable
Object's free hibernation between messages, so any architecture built on
standing warm Fargate capacity is structurally incompatible with this
budget once there's more than a couple of concurrent users.

**Accepted tradeoff:** replacing it means giving up instant preview
claims for brand-new or long-evicted sessions. A new or reconnecting
session pays a real cold start (image pull + boot, likely 20-60s) instead
of claiming a pre-warmed slot. Active sessions being actively viewed do
not pay this cost repeatedly — see Tier 2 below, which is retained.

## What vibesdk provisions for itself

Everything below is stood up by vibesdk's own Terraform
(`aws/infra/` in this repo) — nothing here is shared with or sourced
from another project's infrastructure or state:

- Its own VPC, private subnets, and ALB with host-based routing, ACM/TLS.
  The ALB's job is routing sandbox preview traffic (host/path-based to
  whichever ECS task is currently running a given session's dev server)
  — the control-plane API/WS entrypoint doesn't use it at all (see
  below), so this is a small, purpose-built ALB, not a large shared
  fleet.
- A minimal egress path for sandbox tasks that need outbound internet
  (npm/pip installs during code generation): the reference design's
  pattern of a small Squid proxy on a public-subnet task with its own
  public IP, in place of a NAT Gateway, is worth copying for the same
  reason it was chosen there — it's meaningfully cheaper. Gateway VPC
  endpoints for S3 and DynamoDB (no hourly charge) avoid routing that
  traffic through the egress path at all.
- Its own ECS cluster (Fargate Spot) — used only for on-demand, no-floor
  sandbox tasks (see Cost model), not a standing worker/session-actor
  pool.
- A blue-green/canary Terraform module for apps a user explicitly
  "deploys" long-term (not ephemeral previews) — built within this repo,
  following the same ECR/CodeDeploy canary shape as the reference
  design's pattern, not sourced from it as a remote module.
- SSM Parameter Store for its own config/secrets, DynamoDB on-demand
  tables for operational metadata, CodeArtifact for npm/pip package
  caching if useful, WAF on its own ALB.
- API Gateway (HTTP + WebSocket APIs) and Lambda as the primary compute
  for the control plane and session actors — see Component mapping
  below.
- A DynamoDB-backed rate/budget-governor pattern for vibesdk's own
  per-user rate limiting, built independently (the reference design's
  instance of this pattern governs a different platform's agent spend,
  not something vibesdk reads from or writes to).

**Per-generated-app provisioning speed** was the reference design's model
that didn't fit: "onboarding a new app = commit
`environments/apps/<name>/main.tf`, run `terraform apply`" is fine for a
handful of long-lived platform apps, not for vibesdk's per-session
preview flow where a new "app" (or preview) is created on the order of
every user session. This design's answer instead: an `ecs:RunTask` call
from the provisioning/routing Lambda, launching a sandbox task fresh, on
demand — no Terraform apply per session, no standing pool to claim from
either.

## Component mapping and migration plan

| vibesdk component | AWS target | Effort/risk |
|---|---|---|
| Worker entrypoint (HTTP + WS) | API Gateway (HTTP API + WebSocket API) + Lambda | Medium — no reserved capacity, near-$0 at low traffic; WS push replies go through `apigatewaymanagementapi:PostToConnection` |
| D1 + Drizzle | DynamoDB on-demand, single-table design keyed by entity access patterns. Ported so far: [`aws/db-identity/`](../aws/db-identity/) (`UserService`/`ApiKeyService`/storage layer of `SessionService`, 32 tests), [`aws/db-apps/`](../aws/db-apps/) (core of `AppService`, 26 tests — trending/popular ranking, fork-detachment, comments/likes explicitly not ported), [`aws/db-model-config/`](../aws/db-model-config/) (`ModelProvidersService` + storage layer of `ModelConfigService`, 16 tests), [`aws/db-analytics/`](../aws/db-analytics/) (most of `AnalyticsService`, 9 tests — `batchGetAppStats` excluded), and [`aws/db-auth-flows/`](../aws/db-auth-flows/) (OAuth state/auth attempts/password reset/email verification/OTP storage primitives, 17 tests) against [docs/aws-dynamodb-schema.md](aws-dynamodb-schema.md) — Tables 1-4 all now validated by real code. `ModelTestService` doesn't touch the database at all (an LLM-calling wrapper misplaced in this folder) — nothing to port there. [`aws/auth-crypto/`](../aws/auth-crypto/) ports `PasswordService` and `validatePassword` (15 tests) — pure crypto/logic, no table of its own, the only required change being `crypto.subtle.timingSafeEqual` (a Cloudflare-only Web Crypto extension) swapped for `node:crypto`'s `timingSafeEqual`. [`aws/oauth-clients/`](../aws/oauth-clients/) ports `BaseOAuthProvider`/`GitHubOAuthProvider`/`GoogleOAuthProvider` (15 tests) — pure `fetch`-based OAuth 2.0 + PKCE, no table of its own, changes limited to swapping the Sentry-wired `createLogger` for a minimal injectable `Logger` interface and reading credentials as plain arguments instead of Cloudflare's `Env` binding type. [`aws/db-audit/`](../aws/db-audit/) ports `audit_logs` and `system_settings` (Tables 5-6, 7 tests) — the two tables left unbuilt once every other table's real caller was ported; `audit_logs` has exactly one caller (`SessionService`'s security-event logging) and `system_settings` has none anywhere in the codebase beyond a health-check probe, so `SystemSettingsStore` is a deliberately minimal get/set rather than an invented CRUD API. [`aws/auth-orchestration/`](../aws/auth-orchestration/) ports `AuthService` itself (1178 lines — `register`/`login`/`logout`, OAuth login and account linking, OTP email verification, token validation) plus `SessionService.logSecurityEvent`/`getUserSecurityStatus` (the two `SessionService` methods deliberately left unported pending Table 5), assembling all five packages above via real `file:` npm dependencies rather than duplicating them (the one package in this migration that isn't fully self-contained — see its README for why, the `constructor.name`-vs-`instanceof` fake-DynamoDB gotcha composition surfaced, and the follow-up gap where the fake's `QueryCommand` handler silently ignored `IndexName` instead of erroring). Building it added `OAuthIdentityStore` to `aws/db-identity` (the multi-provider-linking table the schema doc had designed but nothing needed yet) and gave `UserStore.createUser`/`createSession` an optional pre-generated `id` parameter (a real bug — JWT `sessionId` claims not matching persisted sessions — caught by a failing integration test, not inspection). 44 tests, covering full register/login/logout round trips, the OAuth account-takeover-prevention path, CSRF nonce/state-replay rejection, account-linking edge cases (including the primary-provider repoint on unlink, closed by adding `UserStore.setPrimaryProvider` to `aws/db-identity`), and security-event risk scoring. Every storage, crypto, OAuth, and orchestration piece `AuthService` depends on — all six DynamoDB tables in the schema doc — is now ported, with no acknowledged gaps left in the auth surface. | Medium-High — no relational engine, so this is a query-layer rewrite, not a dialect swap (see decision above) |
| R2 | S3 | Low |
| KV | DynamoDB on-demand | Low |
| `DORateLimitStore` | DynamoDB conditional-update token bucket (own implementation of the governor pattern). First cut: [`aws/rate-limit/`](../aws/rate-limit/), unit-tested (11 tests), not yet wired to a real table. | Low-Medium |
| `UserSecretsStore` | Same crypto (VMK/SK hierarchy, AES-GCM — confirmed directly from the current source, not the possibly-stale AES-GCM/XChaCha20-Poly1305 description in this repo's CLAUDE.md) unchanged; storage moves to DynamoDB. See decision 4 below — the Lambda model actually simplifies this. First cut: [`aws/secrets-vault/`](../aws/secrets-vault/), 19 tests including a direct test that the session key is never persisted. | Medium — crypto logic ports directly |
| CF Sandbox / Containers (`UserAppSandboxService`) | On-demand ECS Fargate Spot tasks, launched fresh per session via `RunTask`, no standing pool, reachable via ALB path/host routing for preview URLs | Medium-High — CF's sandbox SDK handles port exposure/proxying/token validation for free; on ECS this needs to be built (a thin router mapping session ID → task IP:port). See Cost model for sizing. |
| Deployer (`wrangler.jsonc` + Workers-for-Platforms dispatch) | Programmatic provisioning: `RunTask` for ephemeral previews, vibesdk's own blue-green Terraform module for apps a user explicitly deploys long-term | High — biggest architectural change from how vibesdk deploys today |
| `CodeGeneratorAgent` (Durable Object actor + state machine) | Lambda, invoked per WebSocket message, no standing worker process. See dedicated section below. | **High — this is the critical-path risk for the whole migration** |
| Git-per-session (isomorphic-git on DO SQLite) | Isomorphic-git unchanged; filesystem adapter re-targeted at S3 only (chunked objects + manifest, no DynamoDB) | Medium — must reach full feature parity with today (see decision 3) |
| `BROWSER` binding (`@cloudflare/puppeteer`) | Headless Chromium via Playwright/Puppeteer, invoked the same way as the session-actor Lambda (per-capture invocation, e.g. a Lambda with a Chromium layer such as `@sparticuz/chromium`, or an on-demand ECS `RunTask` if a capture needs more memory/time than Lambda's limits allow) | Medium — no reserved capacity either way, matches the Lambda-first billing model rather than a standing browser-rendering service |
| AI Gateway (analytics + per-user OAuth-connect) | Feature dropped — no AWS product to connect to (product decision, see [product design doc](aws-migration-product-design.md#2-connect-your-cloudflare-ai-gateway-feature--dropped)). Underlying LLM usage analytics need is kept via CloudWatch/DynamoDB request-metadata logging instead of an external gateway connection. | Low — this is a scope cut, not a port |
| `PartySocket` (frontend WS client) | Native browser `WebSocket` against the API Gateway WebSocket endpoint. `PartySocket`'s reconnect/backoff logic is CF-Agents-SDK-flavored and assumes a DO-style single addressable session endpoint; the AWS side is a standard WS API, so this is a rewrite of the client wrapper (`use-chat.ts`, `websocket-helpers.ts`), not a drop-in swap | Low-Medium — mechanical once the backend's connection/session-resume semantics are finalized (Phase 3) |
| Deploy-to-CF-Workers-for-Platforms UI flow | Already covered by the Deployer row above — same `RunTask`/`app-blue-green` target, just called out separately since it's a second CF surface (`deployer/api/cloudflare-api.ts`) distinct from the AI Gateway OAuth connection | Covered above |

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

None of these exist natively in Lambda or ECS. Proposed replacement,
**Lambda-first**:

- **Compute**: a Lambda function invoked once per inbound WebSocket
  message (via API Gateway WebSocket's `$connect`/`$default`/`$disconnect`
  routes) or per HTTP request. No standing worker process, no pool to
  size — this is the direct AWS analog of a DO's hibernate-between-
  messages behavior, since Lambda has zero idle cost between invocations
  by construction, unlike a Fargate task.
- **Connection routing**: API Gateway assigns each WebSocket connection a
  `connectionId`; a DynamoDB table maps `connectionId → sessionId` (set
  on `$connect`, cleaned up on `$disconnect`). This replaces the earlier
  "pin a session to a worker task" concept entirely — there's no task to
  pin to anymore. The Lambda handling a given message looks up the
  session, processes it, and pushes any response back via
  `PostToConnection` using the stored `connectionId`.
- **Serialization**: per-session mutation lock via a DynamoDB conditional
  write (`sessionId` as key, optimistic lock) — enforces the DO's
  single-threaded guarantee explicitly, same as before, just now guarding
  against concurrent Lambda invocations for the same session instead of
  concurrent access to a shared task.
- **Durability**: state blob persisted to DynamoDB, git object chunks to
  S3, on every mutation — same shape as today's DO-SQLite writes.
- **Rehydration**: happens on *every* invocation now, not just after an
  eviction or interruption — each Lambda invocation loads session state
  fresh (Lambda execution-environment reuse may opportunistically keep a
  warm in-memory cache between back-to-back messages on the same
  session, but this is best-effort, never assumed). This is a real
  latency concern for large sessions (big state blob, deep git history)
  and needs the Phase 3 spike to establish actual per-message latency
  with realistic state sizes — mitigations include keeping the
  DynamoDB-resident state blob small/incremental and only pulling large
  git objects from S3 on operations that actually need them, rather than
  eagerly on every message.

This is the single highest-risk, highest-effort piece of the whole
migration and should be prototyped before committing to the rest of the
plan (see Phase 3 below) — the Lambda-per-message latency profile in
particular needs real measurement, not an estimate.

## Design decisions (resolved)

1. **Per-generated-app provisioning speed — on-demand only, no standing
   pool.** Superseded from the earlier warm-pool draft (see "Rejected"
   above) by the cost budget. Decision is now a single tier:
   - **Sandbox launch.** A session's sandbox task is launched fresh via
     `ecs:RunTask` (Fargate Spot, smallest viable size — see Cost model)
     the moment it's needed, with no pre-warmed pool to claim from. This
     accepts a real cold start (~20-60s) for new/reconnecting sessions.
   - **Tier 2 — activity-based keep-warm for live sessions, retained.**
     Once a session's sandbox task is running (e.g. the user clicks
     "preview"), the client sends a lightweight heartbeat — driven by the
     Page Visibility API, so it only fires while the preview UI is
     actually visible/focused — that resets an idle-eviction timer on
     that task. As long as the UI stays active, the task stays warm and
     pinned, no re-launch needed on reconnect within the same active
     session. When the tab is backgrounded or closed, the heartbeat
     stops; after a grace period with no heartbeat, the task is torn down
     (not returned to a pool — there isn't one) since state is already
     durable in DynamoDB/S3. Re-establishing after teardown pays the same
     cold start as a brand-new session.

   Base-image rollout (previously the blue/green pool's second job) is
   now just an ECR image tag selected at `RunTask` launch time, with a
   canary-style percentage of new launches pointed at the new tag —
   no CodeDeploy needed since these are ephemeral tasks, not a long-running
   service.
2. **WebSocket session routing — API Gateway connection table, not
   worker pinning.** Superseded from "ALB sticky sessions vs. custom
   router" by the Lambda-first compute model: there's no worker task to
   pin a session to anymore. Routing reduces to the standard API Gateway
   WebSocket pattern — a `connectionId → sessionId` DynamoDB table,
   consulted on each message and used for `PostToConnection` pushes.
3. **Git storage medium — S3 only, no DynamoDB in the git path.**
   Unchanged from the earlier decision. S3 alone already gives strong
   read-after-write consistency on both puts and overwrites, and
   prefix-delimited `ListObjectsV2` covers `readdir` — the two things a
   DynamoDB refs table would otherwise be there for. The filesystem
   adapter isomorphic-git needs is re-targeted entirely at S3, mirroring
   today's design: each file's chunks (same 1.8MB chunking scheme) as S3
   objects under a path prefix, with a small manifest object per path
   holding what chunk_index 0 holds today (parent_path, is_dir, size,
   mtime). This is a straight port of the existing adapter's storage
   backend, not a redesign of its logic.

   Feature parity with today is a hard requirement, not a nice-to-have:
   full commit history, `GitVersionControl.commit()/reset()/log()/show()`,
   and full clone protocol support (rebase-on-template) all need to work
   identically post-migration.

   First cut exists: [`aws/git-storage/`](../aws/git-storage/) in this
   repo — the `S3FS` adapter (same public interface, chunking scheme,
   and error semantics as today's `SqliteFS`), unit-tested against an
   in-memory S3 stand-in (28 tests) since no real S3 or local emulator
   was available to test against directly. Not yet integrated with a
   real session or S3 bucket, and not yet tested against actual S3
   (multipart/large-object behavior, IAM edges) — see that directory's
   README.

   Known tradeoff: isomorphic-git does many small reads during tree
   walks, and S3 request latency/cost per object is higher than a local
   DO-SQLite row read. Mitigation: while a sandbox task is warm and
   pinned under Tier 2, it can hold an in-memory LRU cache of recently
   read git objects — S3 round-trips only happen on a cold read or after
   teardown, not on every git operation during an active session. The
   Lambda-based session actor (decision above) does not get this same
   mitigation for free, since it has no persistent process between
   messages — worth watching during the Phase 3 latency spike.
4. **Secrets vault — no session-affinity requirement under the Lambda
   model.** The original DO-based `UserSecretsStore` relies on holding
   `encryptedVMK` in one process's memory for a session's lifetime,
   which needed pinning under the earlier Fargate-pool design. Under the
   Lambda model, that requirement goes away entirely, and arguably
   improves on the original: store `encryptedVMK` (ciphertext, safe to
   persist) in DynamoDB with a TTL matching today's `SESSION_TIMEOUT_MS`;
   require the client to present its session key (SK) on each
   secret-access request rather than expecting the server to remember it;
   decrypt in-memory for the duration of that single Lambda invocation
   only, and never persist the decrypted VMK or the SK itself anywhere.
   The "DB dump = useless encrypted blobs, server memory needs client SK"
   property from the original design is fully preserved — the "server
   memory" in that property just becomes "one Lambda invocation's memory"
   instead of "one DO's memory for the session's duration," and no
   pinned worker is needed to make that true.

   First cut: [`aws/secrets-vault/`](../aws/secrets-vault/) — storage,
   session lifecycle, and decryption ported, with a direct test that the
   session key is never persisted anywhere. WebSocket message routing
   and the connection-auth ticket mechanism (a different, Cloudflare-WS-
   specific concern) are explicitly out of scope for that package — see
   its README.

## Cost model

Numbers below use AWS list pricing (Linux/x86, us-east-1 reference —
ap-southeast-2 runs ~10-20% higher; reprice before committing) and an
**illustrative low-to-moderate usage scenario**, not real vibesdk traffic
— that's still a missing input (see "Data that still needs to come from outside this repo" below).

| Component | Basis | Estimated $/month |
|---|---|---|
| Control-plane compute (API Gateway + Lambda) | Perpetual Lambda free tier (1M requests + 400,000 GB-s/month, forever) likely absorbs most traffic at this scale; API Gateway is ~$1/million HTTP requests, ~$1/million WS messages + connection-minutes | $0-5 |
| Session-actor compute (Lambda, per WS message) | Same free-tier logic as above; this replaced the entire session-worker Fargate pool from the rejected draft | $0-5 |
| DynamoDB (control-plane data + session state + connection table + rate limiting) | On-demand, low request volume | $1-5 |
| S3 (git objects, blobs) | Low storage + request volume at this scale | $1-2 |
| Sandbox compute (Fargate Spot, on-demand `RunTask`, 0.5 vCPU/1 GB — down-sized from the 4 vCPU/8 GB CF spec, see note below) | ~$0.0086/active-hour; even 1,000 active preview-hours/month across all users is ~$8.60 | $2-10 |
| CloudWatch Logs | Short retention (7 days), volume-tuned logging | $2-5 |
| ALB (own, dedicated — no shared platform to amortize against) | Base hourly charge + LCU usage at low traffic | $16-20 |
| Egress path for sandbox outbound installs (small Spot task replacing a NAT Gateway, plus free gateway VPC endpoints for S3/DynamoDB) | ~0.25 vCPU/0.5 GB, roughly the smallest useful Fargate size, run continuously since sandboxes can need it at any time | $3-6 |

**Total: realistically $25-65/month** at low-to-moderate usage — still
comfortably under the $100 budget, but a meaningfully tighter range than
an earlier draft assumed, now that ALB and the egress path are vibesdk's
own dedicated cost rather than shared-platform overhead. Unlike the
rejected warm-pool draft (~$1,300+/month baseline regardless of traffic),
this total scales with actual usage: near-$0 at near-$0 traffic, growing
roughly linearly as real concurrent sessions increase.

**Sandbox sizing note:** 0.5 vCPU/1 GB is a placeholder smaller than
vibesdk's current CF Container spec (4 vCPU/8 GB). Whether that's enough
to run a real dev server (`npm run dev`, install, build) needs validation
during Phase 3/5 — if the smaller size can't handle build-heavy moments,
the design may need the tiered approach discussed earlier (small default
footprint, a separate short-lived heavier task only for actual
build/install operations) rather than a single fixed size.

**Not adopted, and why:** two ideas from the earlier cost-reduction
brainstorm are superseded by this redesign rather than layered on top of
it. Bin-packing multiple sessions onto one Fargate task doesn't apply
once there's no standing session-worker task at all. A Spot-with-overflow
capacity-provider strategy for a near-zero-cost resilience floor is still
architecturally available for the sandbox tier if Phase 3 finds Spot
availability to be a real problem, but isn't part of the baseline design
below the $100 target.

## Defaults chosen to unblock building (revisit after MVP, not before)

Per-decision: don't wait on data that isn't available yet — pick a
reasonable default, build, and let the MVP's real behavior replace the
guess. These are starting points, not final tuning:

- **Lambda sizing** — 1024 MB memory, 30s timeout for the session-actor
  function, to start. Revisit from real Phase 3 latency measurements.
- **Cold-start UX** — accept the 20-60s sandbox cold start for MVP; add a
  simple client-side "waking up" loading state as the default mitigation
  (cheap, no infra dependency). Confirmed as a product decision — see
  [product design doc](aws-migration-product-design.md#1-preview-cold-start-accepted-tradeoff).
- **Sandbox Tier-2 idle-eviction grace period** — default to 90 seconds.
  Tune once real session activity patterns are visible.
- **Sandbox task sizing** — 0.5 vCPU/1 GB per the Cost model, to start.
  If MVP usage shows this can't handle real build/install workloads, move
  to the tiered small/heavy split discussed there.
- **ALB and egress-path sizing** — smallest viable dedicated setup per
  the Cost model (single ALB, single small Spot egress task). Revisit
  only if real traffic shows the egress task needs to scale beyond one
  instance.

## Data that still needs to come from outside this repo (not a build blocker)

- **Current Cloudflare spend baseline** — pull actual usage from the
  vibesdk Cloudflare account (DO duration-GB-s, D1 reads/writes,
  Containers vCPU-seconds, R2 storage/egress) for a real head-to-head
  comparison against the AWS estimate above. Doesn't block building the
  MVP; needed for a real before/after once it exists.
- **Real vibesdk traffic/concurrency numbers** — will come from the MVP
  itself once it's live, replacing the illustrative cost-model numbers
  with real ones.

## Phased plan

1. **Design doc (this document)** — reviewed and agreed before any
   infra or code changes.
2. **Infra scaffolding** — stand up vibesdk's own AWS foundation in
   `aws/infra/` in this repo: VPC, the minimal egress path, ALB, ECS
   cluster, API Gateway (HTTP + WebSocket), Lambda execution role. All
   independent, provisioned and owned by this repo's own Terraform state.
   Provisions the hosting shell only: no vibesdk-specific compute or data
   yet.
3. **Actor-model spike** — prototype the Lambda-per-message replacement
   for `CodeGeneratorAgent` (connection routing, locking, DynamoDB/S3-backed
   state, rehydration-on-every-message) in isolation, before porting the
   full agent. This is the de-risking step; if Lambda-per-message latency
   doesn't hold up under realistic state sizes, it changes the rest of
   the plan. Also where the remaining data points (Lambda-per-message
   latency, cold-start UX tolerance under real use, idle-eviction grace
   period tuning, sandbox sizing validation) replace the defaults set
   above with real numbers.

   First cut exists, both within this repo: `aws/actor-spike/` (Lambda
   handler — connection routing, optimistic per-session lock, state
   round trip, latency logging) and `aws/infra/` (its Terraform —
   WebSocket API, the Lambda, the two DynamoDB tables). Not yet applied
   to real AWS; see each directory's README for what's still needed
   before it can be.
4. **Stateless surface port** — D1→DynamoDB (query-layer rewrite, 10
   migrations' worth of schema to re-derive as access patterns — target
   schema designed in
   [docs/aws-dynamodb-schema.md](aws-dynamodb-schema.md), all six
   tables now ported and tested), R2→S3 (`aws/git-storage/`),
   KV→DynamoDB (`aws/rate-limit/`), port the Worker entrypoint to API
   Gateway + Lambda. Two slices of the entrypoint are done, both
   API Gateway HTTP API (v2) Lambda handlers routing by
   `event.routeKey`'s exact `(method, path)` match instead of a router
   library: [`aws/auth-api-lambda/`](../aws/auth-api-lambda/) ports
   `worker/api/routes/authRoutes.ts` + its controller's HTTP-adapter
   behavior, wired to `aws/auth-orchestration` (11 tests, a full mocked
   GitHub OAuth login round trip included), and
   [`aws/apps-api-lambda/`](../aws/apps-api-lambda/) ports
   `worker/api/routes/appRoutes.ts`'s listing/detail/favorite/star/
   visibility/delete routes, wired to `aws/db-apps` for storage and
   `aws/auth-orchestration` for token validation only (7 tests). Both
   have matching Terraform in `aws/infra/` (`auth-api.tf`,
   `apps-api.tf`), not applied. The rest of `worker/index.ts`
   (analytics, model-config, deployments, and everything else) is not
   yet ported to a Lambda entrypoint — every database primitive those
   would need is already built (`aws/db-analytics`,
   `aws/db-model-config`).
5. **Sandbox + deploy port** — replace `UserAppSandboxService` with
   on-demand `RunTask`-launched sandboxes plus Tier-2 keep-warm (decision
   1), replace the wrangler/dispatch deployer with the AWS provisioning
   path from decision 1, and port the git fs-adapter to S3-only storage
   (decision 3) with parity verified against today's `GitVersionControl`
   behavior.
6. **Cutover** — once parity is verified end-to-end in a non-prod
   environment, plan the actual traffic cutover (DNS, data migration for
   existing D1/DO data if any needs to carry over).

Phases 2 and 3 can run in parallel; Phase 4 depends on neither blocking
the other, but Phase 5 depends on the outcome of Phase 3.
