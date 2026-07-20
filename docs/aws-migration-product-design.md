# Product Design: vibesdk on AWS

## Status

Living document. Reflects decisions made and confirmed while designing
the AWS migration. Companion to
[docs/aws-migration-technical-design.md](aws-migration-technical-design.md),
which covers the "how"; this document covers the "what" and "why" from a
product perspective — what changes for users, what doesn't, and who
decided what.

## Purpose

Move vibesdk off Cloudflare (Workers, Durable Objects, D1, Containers,
Workers-for-Platforms) onto AWS, entirely under vibesdk's own
infrastructure and Terraform. This is a hosting-platform migration, not
a product rebuild — the goal is for the product a user experiences to
stay materially the same.

## Goals

1. **Product parity.** The experience of using vibesdk — describing an
   app in chat, watching it get generated, live-previewing it, seeing
   git history, deploying it — should be unchanged in substance. Backend
   platform changes; the product doesn't.
2. **Cost discipline.** Hosting cost is a hard constraint, not an
   afterthought: **under $100/month at low-to-moderate usage**, scaling
   with real traffic rather than carrying a fixed floor regardless of
   usage. This keeps self-hosting vibesdk viable for the audience the
   open-source project already serves. See the technical design doc's
   Cost model for the numbers behind this.
3. **Full independence.** vibesdk owns and operates all of its own AWS
   infrastructure. It does not depend on, deploy into, or share state
   with any other project's infrastructure, even where architectural
   ideas were borrowed from one for reference.

## Non-goals

- Rewriting the AI agent/codegen logic itself, or changing generation
  quality/behavior. This migration changes where things run, not what
  the product does when generating code.
- Redesigning the chat UI or user-facing product surface, beyond what's
  strictly required by backend platform changes (see below).
- Multi-cloud support. This is a one-way migration target (AWS), not an
  abstraction layer over both clouds.

## User-facing changes (the actual product decisions)

Most of the migration is invisible to users by design — same chat
interface, same generation behavior, same git history and secrets vault
UX. Three things are genuine, confirmed product-level changes:

### 1. Preview cold start (accepted tradeoff)

**Before:** Cloudflare Containers gives near-instant sandbox/preview
availability.
**After:** a new or long-idle session's live preview takes a real cold
start — roughly 20-60 seconds — to spin up, because the architecture
runs sandboxes on-demand with no pre-warmed pool (a pre-warmed pool was
evaluated and rejected: it alone would have blown the entire cost budget
on a handful of concurrent users — see the technical doc's "Rejected:
standing warm-pool architecture").

**Decision:** accept the cold start for the MVP rather than pay for warm
capacity. Mitigate with a simple client-side "waking up" loading state.
Actively-viewed sessions don't repeatedly pay this cost — a UI-visibility
heartbeat keeps an in-use sandbox warm for as long as the user is
actually looking at it.

**Status:** confirmed, not yet built. Whether 20-60s needs further
client-side mitigation (optimistic UI, earlier pre-emptive launch
triggers) is still open — see Open product questions below.

### 2. "Connect your Cloudflare AI Gateway" feature — dropped

**Before:** users could OAuth-connect their own Cloudflare AI Gateway
account for LLM usage analytics and request proxying/caching.
**After:** this feature is removed. There is no AWS product to connect
to — it's a Cloudflare-specific gateway product, not a bring-your-own-
API-key feature (that's the separate secrets vault, which is kept
unchanged).

**Decision:** drop it rather than attempt a workaround. The underlying
need (LLM usage visibility) is preserved differently — usage metadata
gets logged to CloudWatch/DynamoDB instead of routed through an external
gateway a user connects.

**Status:** confirmed scope cut. Revisit only if real usage data
post-MVP shows this was load-bearing for a meaningful number of users —
not a default assumption going in.

### 3. Deploy-generated-app target changes, the action doesn't

**Before:** "Deploy" in the UI publishes the user's generated app to
Cloudflare Workers via Workers-for-Platforms.
**After:** "Deploy" publishes it onto vibesdk's own AWS infrastructure
(an ECS blue-green/canary setup vibesdk operates itself).

**Decision:** the user-facing action and its meaning stay the same
("take my generated app live"); only the destination infrastructure
changes, and it's infrastructure vibesdk now owns end to end rather than
handing off to a third-party platform API.

**Status:** confirmed direction; the actual deploy provisioning path is
not yet built (see technical doc's Phase 5).

## What explicitly does NOT change

- Chat-driven generation flow and UX.
- Git history, diffing, and version control behavior for generated
  projects (full parity with today's `GitVersionControl` behavior is a
  stated hard requirement in the technical design, not optional).
- The secrets vault's security model and user-facing behavior (bring
  your own LLM API keys, encrypted, per-session).
- Rate limiting behavior as experienced by users (implementation changes,
  user-visible limits don't).
- Model/provider choice (OpenAI, Anthropic, Google AI Studio) — unrelated
  to hosting platform.

## Success criteria for the MVP

- A user can complete the full loop — describe an app, watch it
  generate, live-preview it, see git history, deploy it — entirely on
  AWS infrastructure, with no Cloudflare dependency remaining.
- Actual AWS spend at realistic low-to-moderate usage is under the
  $100/month budget (validated against real traffic, not just the
  illustrative cost model).
- Feature parity holds for everything in "What explicitly does NOT
  change" above; the three confirmed changes above are the only
  user-visible differences.
- The two confirmed scope changes (AI Gateway removal, deploy target)
  are communicated to users, not silently dropped.

## Decision log

Dated record of the major product-level calls made during design, most
recent first:

- **AWS infra ownership** — vibesdk provisions and owns 100% of its own
  AWS infrastructure. A separate reference platform's design was used
  for architectural inspiration only (ABAC tagging, blue-green hosting
  shape, Spot-first cost defaults, a DynamoDB governor pattern) — no
  shared infrastructure, Terraform state, or deployment dependency.
- **Cost budget set and held to** — under $100/month, lower if
  achievable. This single constraint drove the rejection of a
  warm-pool architecture and the move to a Lambda-first, on-demand
  compute model.
- **Standing warm-pool architecture rejected** — evaluated and rejected
  once quantified against the cost budget; replaced with Lambda-first
  compute plus on-demand (no pre-warmed pool) sandboxes.
- **AI Gateway connect-your-account feature dropped** — no AWS
  equivalent exists; kept the underlying analytics need via
  CloudWatch/DynamoDB logging instead.
- **20-60s preview cold start accepted** as the tradeoff for hitting the
  cost budget, with UI-activity-based keep-warm retained for active
  sessions and a "waking up" state as the default UX mitigation.
- **No relational database (no Aurora)** — control-plane data moves to
  DynamoDB, accepting that join-shaped admin/analytics queries need
  either a designed access pattern or a separate export path.
- **Git storage moves to S3-only**, with full feature parity to today's
  git behavior stated as a hard requirement, not negotiable scope.

## Open product questions

- **Cold-start UX tolerance** — is 20-60s acceptable as designed, or
  does real usage demand further mitigation (optimistic UI, earlier
  pre-emptive sandbox launch triggers, e.g. on "user started typing a
  prompt")? Needs real usage observation, not a guess — see the
  technical doc's Phase 3 spike.
- **User communication for the two scope changes** — how (if at all) to
  surface the AI Gateway removal and the deploy-target change to
  existing users during cutover. Not yet decided.
- **Current Cloudflare spend and real traffic/concurrency numbers** —
  both needed to validate the cost budget and success criteria against
  reality, not just the illustrative model. See technical doc.
