# csrf

Double-submit-cookie CSRF protection, ported from
[`worker/services/csrf/CsrfService.ts`](../../worker/services/csrf/CsrfService.ts).
Shared by every `aws/*-lambda` that authenticates via the ambient
`accessToken` cookie (`auth-api`, `apps-api`, `user-api`) — a real
crypto-sensitive comparison, not duplicated per-Lambda the way small
stateless helpers (`response.ts`, `fake-dynamo.ts`) are elsewhere in
this migration.

## Mechanism

`GET /api/auth/csrf-token` (aws/auth-api-lambda) mints a token, sets it
as a `csrf-token` cookie (`{token, timestamp}` JSON, `SameSite=Strict`,
2h TTL), and returns the same token in the JSON body.
`src/lib/api-client.ts`'s `fetchCsrfToken` already calls this route and
attaches the token as an `X-CSRF-Token` header on every
POST/PUT/DELETE/PATCH request — no frontend changes were needed.

Every non-GET/HEAD/OPTIONS request is checked: the cookie token and
header token must both be present and match (`timingSafeEqual`,
constant-time). Skipped for requests carrying an explicit
`Authorization: Bearer` or `X-API-Key` header — CSRF only matters for
the ambient cookie; a caller proving possession of a bearer token isn't
relying on the browser to authenticate it.

## Why a shared package, not three duplicated copies

Every other small cross-Lambda helper in this migration (`response.ts`,
`fake-dynamo.ts`, `verifyOrigin`) is intentionally duplicated per
package — it's a few lines with no crypto content, and duplication
avoids a shared-package dependency for something trivial. Token
comparison is different: getting the constant-time-compare or the
cookie-TTL logic wrong independently in three places is a real risk a
shared, once-tested package avoids.

## Not ported

Token rotation on auth events (`rotateToken`, `rotateOnAuth: true` in
the original) and Sentry-flavored security-event capture
(`captureSecurityEvent`) — neither changes whether a request is valid,
both are operational nice-to-haves that can be added without touching
the validation contract this package exposes.

`aws/github-export-lambda` does **not** use this package: it validates
no session cookie at all yet (see its own module comment), so CSRF has
nothing to protect there until its already-flagged missing
ownership/auth check lands first.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```
