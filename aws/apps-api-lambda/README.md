# apps-api-lambda

API Gateway HTTP API (v2) Lambda handler for the app listing/detail/
favorite/star/visibility/delete routes
(`worker/api/routes/appRoutes.ts`, `worker/api/controllers/apps/controller.ts`
+ `worker/api/controllers/appView/controller.ts`), wired to
[`vibesdk-db-apps`](../db-apps/) for storage and
[`vibesdk-auth-orchestration`](../auth-orchestration/) for token
validation only. Same `event.routeKey`-switch shape as
[`aws/auth-api-lambda`](../auth-api-lambda/) — see that package's
README for why no router library is used.

## Auth is read-only here

This package never registers, logs in, or issues tokens — it only
calls `AuthOrchestrator.validateTokenAndGetUser` to resolve whichever
bearer token or `accessToken` cookie a request carries. It still needs
`identityTable`/`authFlowsTable`/`jwtSecret` to construct an
`AuthOrchestrator` at all (the constructor doesn't have a
narrower-scoped "just token validation" variant), so this Lambda's IAM
role needs read access to the identity table even though it never
writes to it — see `aws/infra/apps-api.tf`'s IAM policy for the exact
scoping (`GetItem`/`Query` only, no `PutItem`/`UpdateItem`/
`TransactWriteItems`, unlike the auth Lambda's role).

## Public listing DTO is narrower than the original

`src/public-app-dto.ts` ports `toPublicAppListItem`
(`worker/api/controllers/apps/publicAppDto.ts`), but drops two things
the original has that `vibesdk-db-apps`'s `AppStore` doesn't carry —
not a choice made in this package, a consequence of what was already
excluded when `aws/db-apps` was built:

- `userName`/`userAvatar` — the original joins these from the `users`
  table; `AppStore` is scoped to one DynamoDB table and doesn't join
  across `aws/db-*` packages.
- `forkCount`/`likeCount` — `AppStore` doesn't track these at all
  (fork detachment and comment-likes were excluded from that port).

## What's ported vs. not

Ported: `GET /public` (unauthenticated listing, with optional
personalization — `userStarred`/`userFavorited` — if a valid token is
present), `GET /` (personal apps), `GET /recent`, `GET /{id}` (detail
view — private apps 404 for non-owners, exactly like the original;
records a view for authenticated viewers), `POST /{id}/star`,
`POST /{id}/favorite` (both public-or-owned-app gated, matching the
original's authorization check), `PUT /{id}/visibility` (owner-only,
403 for everyone else), `DELETE /{id}` (owner-only).

Not ported:
- `GET /favorites` (favorites listing) — `AppStore` doesn't have
  `getFavoriteAppsOnly`; it was excluded when `aws/db-apps` was built
  (see that package's README), so there's nothing to wire here without
  adding it there first.
- Git-clone-token and preview-token issuance routes — deploy-token
  concerns that depend on the sandbox/deploy port (Phase 5), not built
  yet.
- Fork — disabled in the original too ("has been disabled for initial
  alpha release, for security reasons").
- Public-endpoint rate limiting
  (`RateLimitService.enforcePublicAppsRateLimit`) — `aws/rate-limit`
  exists and is tested, but isn't wired into this handler yet. A real
  gap for a public unauthenticated listing endpoint, not a silent
  omission.

## Testing

7 tests, no real AWS or DynamoDB: public listing (including the
out-of-range-page rejection from the ported `parsePublicAppsQuery`
bounds), personal-apps-list auth gate, a private app 404ing for a
non-owner but succeeding for the owner (with a view recorded),
favorite/star toggling plus a non-owner's visibility-change attempt
correctly 403ing, and a full create → delete → 404-on-refetch round
trip. `registerUser` in the test file drives the real
`AuthOrchestrator.register` against the same fake table to produce a
valid access token, exactly like a real client would have already
authenticated via `aws/auth-api-lambda` before calling this one.

Uses the same `src/fake-dynamo.ts` copy (constructor-name-based
matching, GSI support) as `aws/auth-api-lambda`, for the same
cross-package `node_modules` reason.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> apps-api-lambda.zip
```

## Status

Not deployed. Every route tested against the fake DynamoDB client; never
run against real API Gateway or DynamoDB. Terraform for its API Gateway
HTTP API + Lambda + scoped IAM role is in
[`../infra/apps-api.tf`](../infra/apps-api.tf), also not applied.
