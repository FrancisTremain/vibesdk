# DynamoDB Schema Design: D1 replacement

Phase 4 groundwork from
[docs/aws-migration-technical-design.md](aws-migration-technical-design.md)
("Stateless surface port"). Maps vibesdk's 22-table D1/Drizzle relational
schema (`worker/database/schema.ts`) onto DynamoDB access patterns, per
that doc's decision to use DynamoDB on-demand instead of Aurora.

Not yet implemented — no Drizzle-to-DynamoDB code exists yet. This is
the design to build against.

## Approach: a handful of purpose-grouped tables, not one giant single-table

The technical design doc says "DynamoDB single-table design"; this
document is more specific about what that means in practice. A true
single physical table holding all 22 entity types under one generic
PK/SK is the canonical DynamoDB pattern, but it's also the hardest to
reason about and the easiest to get wrong without deep DynamoDB
experience on the team. Under **on-demand billing, more tables cost
nothing extra** — DynamoDB on-demand charges for actual read/write
requests and storage, not per-table. So this design uses **six tables,
each grouped by domain**, with entity-prefixed keys inside each so
related entities that need to be queried together (e.g. an app and its
comments) still can be, without forcing unrelated entities (e.g. a user
and a system setting) into the same physical table for no benefit.

**Uniqueness lookups use dedicated items, not GSIs.** DynamoDB GSIs are
eventually consistent — fine for listing/browsing, wrong for "does this
email/username/API-key-hash already exist" checks at registration or
login, which need a strongly-consistent read. Every unique constraint in
the D1 schema (`users.email`, `users.username`, the OAuth
provider+providerId pair, `api_keys.key_hash`, etc.) becomes its own
small lookup item in the base table (strongly-consistent `GetItem`),
separate from GSIs used for range/listing queries.

## Table 1: `vibesdk-identity`

Users, OAuth identities, sessions, API keys — everything on the
authentication hot path, kept together since login always touches
several of these.

| Item type | PK | SK | Notes |
|---|---|---|---|
| User | `USER#<id>` | `PROFILE` | All `users` fields. |
| Email uniqueness lookup | `EMAIL#<email>` | `LOOKUP` | `{ userId }`. Strongly-consistent check on registration; written in the same transaction as the User item (`TransactWriteItems`) to prevent a duplicate-email race. |
| Username uniqueness lookup | `USERNAME#<username>` | `LOOKUP` | `{ userId }`. Same transactional-write pattern. |
| OAuth identity | `USER#<userId>` | `OAUTH#<provider>#<providerId>` | A user can have more than one linked identity — this is the natural one-to-many the SK expresses. |
| OAuth provider-lookup | `OAUTHLOOKUP#<provider>#<providerId>` | `LOOKUP` | `{ userId }`. Strongly-consistent read at OAuth login — this is the one that most needs to not be a GSI, since a login racing a just-completed identity link is a real scenario. |
| Session | `USER#<userId>` | `SESSION#<sessionId>` | All `sessions` fields. `expires_at` as a DynamoDB TTL attribute — replaces the `expiresAtIdx` cleanup pattern with automatic expiry instead of a cron sweep. |
| Session token lookup | `SESSTOKEN#<accessTokenHash>` | `LOOKUP` | `{ userId, sessionId }`. Every authenticated request does this lookup — needs to be fast and strongly consistent, hence a dedicated item, not a GSI on the Session item. |
| API key | `USER#<userId>` | `APIKEY#<id>` | All `api_keys` fields. |
| API key hash lookup | `APIKEYHASH#<keyHash>` | `LOOKUP` | `{ userId, apiKeyId }`. Same reasoning as session token lookup — this is the per-request auth check. |

GSI `by-provider` (GSI1PK=`provider`, GSI1SK=`created_at`) on the User
item type only — supports admin-style "list users by OAuth provider,"
a low-frequency query that can tolerate eventual consistency.

## Table 2: `vibesdk-apps`

Apps and every social/engagement entity attached to one (favorites,
stars, likes, comments, comment likes, views) — grouped together since
"show me an app plus its engagement" is the dominant read pattern.

| Item type | PK | SK | Notes |
|---|---|---|---|
| App | `APP#<id>` | `META` | All `apps` fields. |
| Favorite | `APP#<appId>` | `FAV#<userId>` | Enables "who favorited this app" via a `Query` on `APP#<id>` with an SK prefix of `FAV#`. |
| Favorite (reverse) | `USER#<userId>` | `FAV#<appId>` | Duplicated the other direction — this is the standard DynamoDB "write twice for two access patterns" tradeoff, needed for "show me this user's favorited apps" without a table scan. Written together via `TransactWriteItems`. |
| Star / App-like / Comment-like | Same pattern as Favorite: forward + reverse item pair | | `stars`, `app_likes`, `comment_likes` all follow the identical shape. |
| Comment | `APP#<appId>` | `COMMENT#<id>` | Threaded replies (`parentCommentId`) are a plain attribute; fetching a comment's replies is a `Query` filtered client-side, or a second reverse-lookup item (`COMMENT#<parentId>` → `REPLY#<id>`) if reply-listing turns out to be a hot path. Start without it, add if needed. |
| View | `APP#<appId>` | `VIEW#<viewedAt>#<viewerHash>` | High write volume, short-lived value — candidate for a TTL attribute if historical view records don't need to be kept indefinitely (D1's `appViewerIdx` unique-per-viewer constraint becomes a conditional write on this same key instead of a separate lookup). |

GSI `by-user` (GSI1PK=`userId`, GSI1SK=`created_at`) on the App item —
"list this user's apps," the profile-page query. GSI `by-visibility`
(GSI2PK=`visibility`+`status` composite, GSI2SK=`updated_at`) — the
public app gallery / discovery listing.

**Known gap, not solved here: full-text search.** D1's `apps_search_idx`
on `(title, description)` has no DynamoDB equivalent — DynamoDB doesn't
do free-text search. Options: OpenSearch Service (real cost, likely
blows the cost budget for an MVP), a lighter self-hosted search index,
or accepting degraded search (prefix-match on title via a GSI, or
client-side filtering over a bounded result set) for the MVP and
revisiting if search quality turns out to matter to users. **Flagged as
an open product/technical question, not decided here** — see the
product design doc's open questions.

## Table 3: `vibesdk-auth-flows`

Short-lived, TTL-heavy authentication flow state: OAuth CSRF state,
login attempt tracking, password reset / email verification tokens,
OTPs. Grouped together because every item here is transient by nature —
all get a DynamoDB TTL attribute, replacing what were D1 `expiresAtIdx`
indexes plus (implicitly) some cleanup job.

| Item type | PK | SK | TTL source |
|---|---|---|---|
| OAuth state | `OAUTHSTATE#<state>` | `STATE` | `expires_at` |
| Auth attempt | `AUTHATTEMPT#<identifier>` | `ATTEMPT#<attemptedAt>` | Short fixed TTL (e.g. 24h) — rate-limit/lockout logic reads a bounded recent window via `Query` with an SK range, not the full history. |
| Password reset token | `PWRESET#<tokenHash>` | `TOKEN` | `expires_at` |
| Email verification token | `EMAILVERIFY#<tokenHash>` | `TOKEN` | `expires_at` |
| Verification OTP | `OTP#<email>` | `OTP#<createdAt>` | `expires_at` |

No GSIs needed — every access pattern here is a direct key lookup or a
bounded SK-range query.

## Table 4: `vibesdk-model-config`

Per-user LLM provider/model configuration — `user_model_configs`,
`user_model_providers`. Note: `cloudflare_accounts` and `ai_gateways`
are **not ported** — both exist solely to support the AI Gateway
connect-your-account feature, which the product design doc drops
outright (no AWS equivalent). Dropping two full tables is a direct,
concrete benefit of that scope cut.

| Item type | PK | SK |
|---|---|---|
| Model config | `USER#<userId>` | `MODELCONFIG#<agentActionName>` |
| Model provider | `USER#<userId>` | `MODELPROVIDER#<name>` |

Both are naturally scoped to a user and queried as "give me this user's
full config," a single `Query` on `USER#<userId>` with an SK prefix —
no GSI needed.

## Table 5: `vibesdk-audit-log`

`audit_logs` alone — high write volume, append-only, queried by entity
or by time range, never updated. Kept separate from the other tables so
its (potentially large) storage/throughput profile doesn't get bundled
with latency-sensitive identity/app reads.

| Item type | PK | SK |
|---|---|---|
| Audit entry | `ENTITY#<entityType>#<entityId>` | `LOG#<createdAt>#<id>` |

GSI `by-user` (GSI1PK=`userId`, GSI1SK=`created_at`) for "show this
user's activity." Consider a shorter TTL or periodic export to S3 if
audit volume grows — not needed for MVP.

## Table 6: `vibesdk-system-settings`

`system_settings` alone — tiny, low-traffic, global config. `PK:
SETTING#<key>`. No SK, no GSI. Barely worth calling a "table" but kept
separate rather than folding into another domain's table for no reason.

## What this doesn't cover yet

- Exact attribute-level types/validation (carries over directly from
  `schema.ts` — mechanical, not a design decision).
- Migration/backfill from existing D1 data, if any needs to survive
  cutover (see technical doc's Phase 6).
- The actual Drizzle-to-DynamoDB query-layer rewrite in
  `worker/database/services/*` — this document is the target schema
  those services get rewritten against, not the rewrite itself.
- Full-text search replacement (flagged above as open).
