# auth-api-lambda

API Gateway HTTP API (v2) Lambda handler for the auth routes —
Phase 4's "port the Worker entrypoint to API Gateway + Lambda"
(`docs/aws-migration-technical-design.md`) for the auth slice
specifically, since it's the piece with every underlying primitive
already ported and tested. Ports
[`worker/api/routes/authRoutes.ts`](../../worker/api/routes/authRoutes.ts)
+ [`worker/api/controllers/auth/controller.ts`](../../worker/api/controllers/auth/controller.ts)'s
HTTP-adapter behavior — status codes, redirect locations, cookie
names, response envelope shape — onto one Lambda dispatched by
`event.routeKey`, wired to
[`vibesdk-auth-orchestration`](../auth-orchestration/).

## Why one Lambda, one `switch`, not a router library

The original uses Hono for routing plus a middleware chain
(`setAuthLevel`, `adaptController`) that resolves `routeContext.user`
before the controller runs. API Gateway HTTP API's `routeKey`
(`"POST /api/auth/register"`) already gives an exact string match per
route — a `switch` over eleven cases doesn't need a router library on
top of it. Auth resolution is inlined per route instead of a
middleware layer (`requireUser(event)` called explicitly wherever a
route needs it) since there's no middleware chain here to hang it on.

## Cookies: API Gateway's structured support, not manual parsing

The original manually parses the `Cookie` header
(`worker/utils/authUtils.ts`'s `parseCookies`) and builds `Set-Cookie`
strings by hand, including a dev/prod `__Host-` prefix dance
(`worker/utils/oauthCookie.ts`) since Cloudflare Workers can run over
plain HTTP locally. API Gateway HTTP API v2 pre-parses `event.cookies`
into an array and joins a Lambda response's `cookies` array into
`Set-Cookie` headers automatically — `src/cookies.ts` uses that
instead, and always sets `Secure` (a Lambda deployment behind API
Gateway is always HTTPS, no dev-mode plain-HTTP case to special-case
for).

## What's ported vs. not

Ported: `register`, `login`, `logout`, `check`, `profile` (read-only),
`verify-email`, `resend-verification`, `oauth/{provider}` (initiate
login), `link/{provider}` (initiate authenticated account-link),
`callback/{provider}` (handles both the login and account-link
callback shapes, exactly like the original's single
`handleOAuthCallback` branching on whether the state carries a
`userId`), `identities` (list), `identities/{provider}` (unlink).

Not ported:
- Session-list (`GET/DELETE /api/auth/sessions*`) and API-key
  management (`GET/POST/DELETE /api/auth/api-keys*`, `/exchange-api-key`)
  routes -- `aws/db-identity`'s `SessionStore`/`ApiKeyStore` cover the
  storage, but `AuthOrchestrator` doesn't expose them as orchestration
  methods yet (it only uses `SessionStore` internally for
  `createSession`/`revokeSessionId`/`getUserSessions`). Wiring these up
  is mechanical once `AuthOrchestrator` grows the methods; not done
  speculatively without a caller.
- `updateProfile` -- needs `UserStore.updateUserProfile`/
  `isUsernameAvailable` wiring that `AuthOrchestrator` doesn't
  currently expose either, same reasoning.
- `csrf-token`/`providers` (capability-listing routes) and `CsrfService`
  token rotation on successful auth -- the original's CSRF defense is a
  double-submit cookie pattern layered on top of Cloudflare's cookie
  handling; arguably redundant here once every mutating route already
  requires either a bearer token (not readable by a CSRF attacker) or
  an `HttpOnly`, `SameSite=Lax` cookie (not attachable to a cross-site
  fetch that could read the response). Not ported; flagged as a
  decision worth revisiting with real security review, not a silent
  omission.
- Cloudflare OAuth and its callback's AI Gateway auto-connect side
  effect -- out of scope everywhere else in this migration too (see
  the product design doc).

## Auth resolution

`requireUser(event)` reads a bearer token from `Authorization: Bearer
<token>` first, then the `accessToken` cookie, then calls
`AuthOrchestrator.validateTokenAndGetUser` -- the same
live-session-cross-check behavior as the original (logout/revoke take
effect immediately, not at JWT `exp`), just resolved per-route instead
of via `RouteContext.user` injected by middleware.

## Testing

11 tests, no real AWS or DynamoDB: register (including the
missing-field and duplicate-email rejection paths), login, `/check`
both authenticated and not, `/profile`'s 401-then-200 with a Bearer
token, logout clearing the cookie and immediately invalidating the
token, OAuth initiation building an authorization URL and nonce
cookie, an unsupported provider rejected before any DynamoDB call, a
full GitHub login callback round trip (state issued, GitHub mocked via
`vi.stubGlobal('fetch', ...)`, callback consumes the state and returns
an access-token cookie), and the callback's missing-`state` guard.

Uses `src/fake-dynamo.ts`, an unmodified copy of
`aws/auth-orchestration`'s fake (constructor-name-based matching, GSI
query support) -- this package hits the exact same cross-package
`node_modules` boundary that fake was built to handle, since
`AuthOrchestrator` itself composes stores from `aws/db-identity`,
`aws/db-auth-flows`, and `aws/db-audit`. `getAuth()` normally
constructs a real `DynamoDBDocumentClient`; `setDdbClientForTests`
overrides it and drops the cached `AuthOrchestrator` singleton so the
next call rebuilds against the fake.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> auth-api-lambda.zip
```

## Deployment shape (not yet applied)

Expects these environment variables: `PUBLIC_BASE_URL`,
`IDENTITY_TABLE`, `AUTH_FLOWS_TABLE`, `AUDIT_TABLE` (optional --
security-event logging degrades to a no-op without it, same as
`AuthOrchestrator`'s own default), `JWT_SECRET`, `ALLOWED_EMAIL`
(optional), `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (either OAuth pair is
optional -- omit to disable that provider). Terraform for the API
Gateway HTTP API + this Lambda is not part of `aws/infra/` yet; the
existing Terraform there only covers the actor-spike's WebSocket API
and the six application DynamoDB tables' storage, not an HTTP API
surface.

## Status

Not deployed. Every route is tested against the fake DynamoDB client
and real (unmocked) crypto/JWT/OAuth-client logic; never run against
real API Gateway or DynamoDB.
