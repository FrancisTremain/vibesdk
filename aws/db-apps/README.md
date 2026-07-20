# db-apps

DynamoDB port of the core of `AppService` — the apps slice of D1 — per
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md)'s Table 2,
ported from [`worker/database/services/AppService.ts`](../../worker/database/services/AppService.ts)
(1180 lines).

## Scope: a deliberate subset, not all ~30 methods

**Ported, faithfully:** `createApp`, `updateApp` (+ its three setter
wrappers), `checkAppOwnership`, `getSingleAppWithFavoriteStatus`,
`updateAppVisibility`, `getAppOwnershipByDeploymentId`,
`getPreviewVersion`, `getAppDetails`, `toggleAppFavorite`,
`toggleAppStar`, `recordAppView`, `getUserAppsWithFavorites`,
`getRecentAppsWithFavorites`, `getPublicApps` (simplified, see below),
`deleteApp` (simplified, see below).

**Not ported, named rather than silently dropped:**
- The weighted trending/popular ranking algorithm (`executeRankedQuery`,
  `RANKING_WEIGHTS`, time-period-windowed recentViews/recentStars).
  `getPublicApps` here only supports recent/oldest sort. Real ranking
  needs its own DynamoDB design (likely a maintained score attribute +
  GSI) — a separate piece of work.
- `getUserAppsWithAnalytics`'s 'starred' sort branch and full
  ranked-query path, `getUserAppsCount`, `getFavoriteAppsOnly`.
- `deleteApp`'s fork-detachment step (nulling `parentAppId` on any app
  that forked from the one being deleted) — would need a `by-parent`
  GSI not designed here. **Real gap**: deleting an app that has forks
  leaves their `parentAppId` pointing at a deleted app under this port.
- Screenshot URL signing (`ScreenshotSecurity`) — a separate, unrelated
  concern (CDN URL signing), not a storage question. `screenshotUrl` is
  stored and returned as-is.
- Comments, comment-likes, app-likes (D1's `app_comments`/
  `comment_likes`/`app_likes` tables) — not modeled in this package at
  all.

## The search decision

Product decision (see `docs/aws-migration-product-design.md`'s decision
log): degrade search for the MVP. `getPublicApps({ search })` here does
a case-insensitive **prefix** match on `title` only. The original does a
case-insensitive **substring** match across both `title` and
`description` — meaningfully more permissive. Concretely, searching
`"todo"` here matches an app titled *"Todo App"* but not one titled
*"My Todo Thing"* or one with "todo" only in its description; the
original would match both. No OpenSearch, no added infrastructure cost.
The `'searches by title prefix ... not substring'` test documents this
gap directly rather than leaving it implicit.

## Counters are a genuine improvement, same pattern as `db-identity`

`starCount`/`favoriteCount`/`viewCount` live on the app item itself,
maintained via atomic DynamoDB `ADD` in the same `TransactWriteItems`
call as the star/favorite/view record — not computed live via
`COUNT(*)`/`COUNT(DISTINCT ...)` against separate tables on every read,
like the original. Cheaper and simpler at read time. The `recordAppView`
dedup marker (`VIEW#<viewerHash>`) is TTL'd to the end of its dedup
bucket, giving automatic cleanup with exactly the semantics the original
wanted (dedup only within a bucket) rather than an accident of expiry.

## The public listing GSI

An earlier draft of the schema doc proposed a `visibility`+`status`
composite GSI partition key for the public listing. The actual
qualifying condition (`visibility = public OR userId IS NULL` AND
`status IN (completed, generating)`) isn't a single equality a DynamoDB
partition key can express. This port uses a **constant-partition
"listing index"** instead — every qualifying app lives in one GSI
partition (`gsi2pk = 'LISTING'`), maintained at write time by
`putApp`'s `qualifiesForPublicListing` check. Accepted tradeoff: one hot
partition, fine at MVP scale, worth revisiting only if listing traffic
grows enough to matter. See the schema doc for the same reasoning
written out in more detail.

## Two more lookup-by-ID gaps found by building this

Same pattern as `aws/db-identity`: `getAppOwnershipByDeploymentId`
looks up by `deploymentId` directly, with no `appId` available to the
caller. Fixed with a `DEPLOYMENTID#<deploymentId>` lookup item, added to
the schema doc after being found here — not something the paper design
anticipated.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is the most involved fake built in this repo so
far — the first one needing GSI query support (`gsi1`/`gsi2`), on top
of `TransactWriteItems` and negative-delta `ADD` (for decrementing
counters on unfavorite/unstar). 26 tests cover app CRUD, ownership,
visibility toggling with `previewVersion` bump, favorites/stars with
counter maintenance, view dedup, user and public listings (including
the prefix-search behavior above), pagination, and delete with edge
cleanup.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
Needs a real DynamoDB table with both GSIs configured, and whatever
calls the ported `AppService` methods today rewired to call this
instead.
