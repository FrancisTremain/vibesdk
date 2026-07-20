# db-analytics

DynamoDB port of the feasible part of `AnalyticsService`, per
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md)'s
Table 2. Ports [`worker/database/services/AnalyticsService.ts`](../../worker/database/services/AnalyticsService.ts)
(255 lines).

## Reads the `aws/db-apps` table directly — a real, stated coupling

This package doesn't depend on `aws/db-apps` as a library, but it does
read the same `vibesdk-apps` table using the same key scheme
(`APP#<id>`/`META`, the `gsi1` index keyed by `userId`, and the
`USER#<userId>`/`FAVAPP#<appId>` reverse favorite-lookup items). If that
table's key scheme changes, this package needs to change with it. Not
hidden — stated here and in the module comment.

## Why most of this port is cheap, not another aggregation wall

`AppService`'s ranking algorithm hit a real wall porting to DynamoDB
(no arbitrary `GROUP BY`/weighted scoring) — see `aws/db-apps`'s README.
`AnalyticsService` mostly avoids that wall for one reason:
`aws/db-apps` already maintains `favoriteCount`/`viewCount` on each app
item via atomic `ADD`, not a live `COUNT(*)`. `getUserStats`'s "total
likes/views received across a user's apps" becomes summing two
already-maintained numbers across a `Query` result (one read), not a
join. This is the payoff of that earlier design decision showing up in
a second package.

## Not ported

`batchGetAppStats` — needs `forkCount` (would require a `by-parent` GSI,
explicitly not built in `aws/db-apps`, a named gap there already) and
`likeCount` from the `app_likes` table (not modeled anywhere in this
migration yet). Both are already-flagged upstream gaps; this package
doesn't invent a fake number to paper over them.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is copied from `aws/db-apps` unchanged (same GSI
query support needed). Tests seed app/favorite items the way
`aws/db-apps`'s `AppStore` would actually write them, then verify
`getUserStats` (counts, summed counters, streak calculation across
several scenarios including the "same-day activity counts once" case)
and `getUserActivityTimeline` (merged/sorted app + favorite activity,
limit handling). 9 tests.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
