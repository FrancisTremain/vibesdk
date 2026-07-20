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
| Session ID lookup | `SESSIONID#<sessionId>` | `LOOKUP` | `{ userId }`. **Added after building the actual port** (`aws/db-identity/`) — `UserService.findValidSession(sessionId)` looks up by the session's own ID directly, with no `userId` available to the caller at that point. The original design here only accounted for the access-token-hash lookup; this is a second, distinct lookup path the paper design missed until the code that needed it got written. |
| API key | `USER#<userId>` | `APIKEY#<id>` | All `api_keys` fields. |
| API key hash lookup | `APIKEYHASH#<keyHash>` | `LOOKUP` | `{ userId, apiKeyId }`. Same reasoning as session token lookup — this is the per-request auth check. |
| API key ID lookup | `APIKEYID#<keyId>` | `LOOKUP` | `{ userId }`. Same gap, same fix as the session ID lookup above — `ApiKeyService.getApiKeyById(keyId)` needs it. |

`UserService`, `ApiKeyService`, and the storage layer of
`SessionService` are ported and tested against this table shape in
[`aws/db-identity/`](../aws/db-identity/) (38 tests, including the
`TransactWriteItems`-backed uniqueness guarantees for
email/username/API-key-hash). The `user_oauth_identities` table (D1's
separate multi-provider-linking table, SK `OAUTH#<provider>#<providerId>`
nested under a user) is now ported too, as `OAuthIdentityStore` — added
once [`aws/auth-orchestration/`](../aws/auth-orchestration/)'s
account-linking flows became the first real caller; `UserService.findUser`'s
own provider lookup still reads `provider`/`providerId` directly off
the user record, so this table is purely additive for multi-provider
linking.

GSI `by-provider` (GSI1PK=`provider`, GSI1SK=`created_at`) on the User
item type only — supports admin-style "list users by OAuth provider,"
a low-frequency query that can tolerate eventual consistency.

## Table 2: `vibesdk-apps`

Apps and every social/engagement entity attached to one (favorites,
stars, likes, comments, comment likes, views) — grouped together since
"show me an app plus its engagement" is the dominant read pattern.

| Item type | PK | SK | Notes |
|---|---|---|---|
| App | `APP#<id>` | `META` | All `apps` fields, plus three maintained counters (`starCount`/`favoriteCount`/`viewCount`) not in the D1 schema — see below. |
| Favorite | `APP#<appId>` | `FAV#<userId>` | Enables "who favorited this app" via a `Query` on `APP#<id>` with an SK prefix of `FAV#`. |
| Favorite (reverse) | `USER#<userId>` | `FAVAPP#<appId>` | Duplicated the other direction — this is the standard DynamoDB "write twice for two access patterns" tradeoff, needed for "show me this user's favorited apps" without a table scan. Written together via `TransactWriteItems`. |
| Star (forward + reverse) | Same pattern as Favorite | `STAR#<userId>` / `STARAPP#<appId>` | `app_likes`/`comment_likes`/comments are not part of the port below — see status note. |
| Deployment ID lookup | `DEPLOYMENTID#<deploymentId>` | `LOOKUP` | `{ appId }`. **Added after building the actual port** (`aws/db-apps/`) — same class of gap as the identity table's `SESSIONID#`/`APIKEYID#` lookups: `getAppOwnershipByDeploymentId` looks up by deployment ID directly, a paper design easily misses until the code that needs it gets written. |
| View (dedup marker) | `APP#<appId>` | `VIEW#<viewerHash>` | TTL'd to the end of the current dedup bucket (`viewedAt` window), not kept indefinitely — the original's per-viewer-per-bucket dedup constraint becomes a conditional write (`attribute_not_exists`) on this same key, and the TTL doubles as automatic cleanup with exactly the intended "dedup only within a bucket" semantics, not an accident of expiry. |

GSI `by-user` (`gsi1pk`=`userId`, `gsi1sk`=`updatedAt`) on the App item
— "list this user's apps." GSI `by-listing` (`gsi2pk`= a **constant**
partition value, `gsi2sk`=`updatedAt`) for the public app gallery —
simplified from an earlier draft of this doc, which proposed a
`visibility`+`status` composite partition key. The actual qualifying
condition (`visibility = public OR userId IS NULL`) `AND` (`status IN
(completed, generating)`) isn't a single equality DynamoDB's partition
key can express directly; a constant-partition "listing index" — every
qualifying app in one GSI partition, filtered/maintained at write time
— is the idiomatic DynamoDB shape for a bounded, browsable listing like
this one. Accepted tradeoff: a single hot partition, fine at MVP list
sizes, worth revisiting (e.g. shard by a coarse time bucket) only if
listing traffic grows enough for it to matter.

**Search: resolved, not open.** D1's `apps_search_idx` on
`(title, description)` has no DynamoDB equivalent. **Decision:**
degrade to prefix-match on `title` only for the MVP (client-side
filter over the listing GSI's result set, no OpenSearch, no added
cost) — see the product design doc's decision log. This was an open
question in an earlier draft of this doc; it's resolved now, following
the same "pick a default, build, let real usage replace the guess"
reasoning as every other MVP default in the technical design doc.

**Status:** `AppStore` in [`aws/db-apps/`](../aws/db-apps/) ports the
App/Favorite/Star/View shapes above and is tested (26 tests) against
this schema. Comments, comment-likes, and app-likes (D1's
`app_comments`/`comment_likes`/`app_likes` tables) are **not** part of
that port — not modeled here in detail yet, deferred until they're
actually being built. The weighted trending/popular ranking algorithm
and fork-detachment-on-delete are also not ported — see that package's
README for the full list of what's deliberately excluded and why.

## Table 3: `vibesdk-auth-flows`

Short-lived, TTL-heavy authentication flow state: OAuth CSRF state,
login attempt tracking, password reset / email verification tokens,
OTPs. Grouped together because every item here is transient by nature —
all get a DynamoDB TTL attribute, replacing what were D1 `expiresAtIdx`
indexes plus (implicitly) some cleanup job.

| Item type | PK | SK | TTL source |
|---|---|---|---|
| OAuth state | `OAUTHSTATE#<state>` | `STATE` | `expires_at` |
| Auth attempt | `AUTHATTEMPT#<identifier>` | `ATTEMPT#<attemptedAt>#<randomId>` | Short fixed TTL (24h) — lockout logic queries the whole (TTL-bounded, naturally small) recent partition and filters by timestamp client-side, not an SK range condition. |
| Password reset token | `PWRESET#<tokenHash>` | `TOKEN` | `expires_at` |
| Email verification token | `EMAILVERIFY#<tokenHash>` | `TOKEN` | `expires_at` |
| Verification OTP | `OTP#<email>` | `OTP#<createdAt>` | `expires_at` |

No GSIs needed — every access pattern here is a direct key lookup or a
bounded partition query.

**Corrected after building the actual port** (`aws/db-auth-flows/`):
the auth-attempt SK gained a `#<randomId>` suffix — multiple attempts
can land in the same millisecond, and the SK needs to stay unique per
item. The originally proposed "read via an SK range" access pattern
also turned out awkward against that suffix, so `AuthAttemptStore`
queries the identifier's whole partition (already TTL-bounded to 24h,
so never large) and filters by `attemptedAt` client-side instead —
simpler than a real range condition and behaviorally identical.

**Status:** all five item types above are ported and tested (17 tests)
in [`aws/db-auth-flows/`](../aws/db-auth-flows/) — storage primitives
only. `AuthService`'s orchestration layer itself (register/login/OAuth
callback flows, password crypto, OAuth provider clients) is ported
separately in [`aws/auth-orchestration/`](../aws/auth-orchestration/),
which assembles this package with `aws/db-identity`, `aws/auth-crypto`,
and `aws/oauth-clients`.

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
| Model provider | `USER#<userId>` | `MODELPROVIDER#<id>` |
| Model provider name lookup | `USER#<userId>` | `MODELPROVIDERNAME#<name>` |

Both are naturally scoped to a user and queried as "give me this user's
full config," a single `Query` on `USER#<userId>` with an SK prefix —
no GSI needed.

**Corrected after building the actual port** (`aws/db-model-config/`):
the provider item is keyed by its own ID, not by name as an earlier
draft of this row proposed. `getProvider(userId, providerId)` is the
access pattern `updateProvider`/`deleteProvider`/`toggleProviderStatus`
all actually use — keying by name alone would have made that
impossible without an ID→name lookup anyway, so the ID is the primary
key and a `MODELPROVIDERNAME#<name>` lookup item (written
transactionally, same pattern as the identity table's username
handling) covers `getProviderByName` and the real `(userId, name)`
uniqueness constraint instead.

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

**Status:** both tables are ported and tested (7 tests) in
[`aws/db-audit/`](../aws/db-audit/). `system_settings` has no real
caller anywhere in `worker/database/services/` beyond a health-check
probe, so `SystemSettingsStore` stays a minimal get/set rather than an
invented CRUD API. All six tables in this document are now backed by
real, tested code.

## What this doesn't cover yet

- Exact attribute-level types/validation (carries over directly from
  `schema.ts` — mechanical, not a design decision).
- Migration/backfill from existing D1 data, if any needs to survive
  cutover (see technical doc's Phase 6).
- The actual Drizzle-to-DynamoDB query-layer rewrite in
  `worker/database/services/*` — this document is the target schema
  those services get rewritten against, not the rewrite itself.
- Full-text search replacement (flagged above as open).
