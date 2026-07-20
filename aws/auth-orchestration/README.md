# auth-orchestration

Port of `AuthService` (`worker/database/services/AuthService.ts`, 1178
lines) — register/login/logout, OAuth login, OAuth account linking,
email verification by OTP, and token validation — plus
`SessionService.logSecurityEvent`/`getUserSecurityStatus`, the two
`SessionService` methods `aws/db-identity` deliberately left unported
pending an audit-log table. This is the orchestration layer every
other `aws/auth-*`/`aws/db-*`/`aws/oauth-*` package in this migration
was built toward: it assembles [`vibesdk-db-identity`](../db-identity/)
(users, sessions, API keys, OAuth identities),
[`vibesdk-db-auth-flows`](../db-auth-flows/) (OAuth CSRF state,
auth-attempt log, verification OTPs), [`vibesdk-auth-crypto`](../auth-crypto/)
(password hashing + strength validation),
[`vibesdk-oauth-clients`](../oauth-clients/) (GitHub/Google HTTP
clients), and [`vibesdk-db-audit`](../db-audit/) (audit log, optional)
into `AuthOrchestrator`, a single class with the same
register/login/OAuth-callback surface as the original.

## Composition, not duplication

Every other `aws/*` package in this migration is fully self-contained
(no cross-package imports), including duplicating small shared pieces
like `fake-dynamo.ts` rather than reusing another package's copy. This
package breaks that pattern deliberately: assembling the real
`AuthService` orchestration on top of five already-built, already-tested
packages by re-implementing all of them inline would mean thousands of
lines of copy-pasted stores, crypto, and OAuth clients with no way to
keep them in sync. Instead, the dependencies are real `file:` npm
dependencies (`"vibesdk-db-identity": "file:../db-identity"`, etc.), and
each of those packages' `package.json` gained `main`/`types` fields
plus a `tsc --emitDeclarationOnly` build step (in addition to their
existing esbuild bundle) so this package can import their real classes
with real type declarations — nothing about their own behavior, tests,
or exports changed.

Two consequences worth calling out:

1. The in-memory `fake-dynamo.ts` used for testing matches commands by
   `constructor.name`, not `instanceof`. Commands built inside a
   sibling package's bundled `dist/index.js` come from *that package's
   own* `node_modules` copy of `@aws-sdk/lib-dynamodb` -- a different
   module instance than the one this package's fake imports, even at
   the identical version. `instanceof` fails silently across that
   boundary (throws "unhandled command" for every operation);
   `constructor.name` doesn't care which module instance built the
   class. Every other package's fake still uses `instanceof`, since
   none of them drive commands built outside their own module graph.
2. The fake also needed GSI query support (`IndexName`), copied from
   `aws/db-apps`'s more capable fake -- `aws/db-identity`'s copy
   (this package's starting point) never needed one, but
   `vibesdk-db-audit`'s `AuditLogStore.listForUser` queries a `by-user`
   GSI. Caught by a test that silently returned zero events instead of
   erroring — the fake's base `QueryCommand` handler ignored
   `IndexName` entirely rather than failing loudly, so the gap surfaced
   as a wrong answer, not a thrown error worth noticing immediately.

## Two real gaps this port surfaced

Both were caught by writing an actual integration test, not by
inspection -- the same pattern as every "gap the paper design missed"
noted in `docs/aws-dynamodb-schema.md`:

1. **`UserStore.createUser`/`createSession` couldn't accept a
   caller-supplied id.** The original `AuthService.register` generates
   `userId` itself and self-references it as `providerId` for
   email/password signups; `SessionService.createSession` generates a
   session id once and uses it both to sign the JWT's `sessionId` claim
   and to persist the session row, so the two always match. `db-identity`'s
   `UserStore.createUser`/`createSession` generated their own ids
   internally with no way to influence them -- fine for every prior
   caller (which never needed to pre-know the id), but wrong here.
   Fixed with a minimal, backward-compatible change: both now take an
   optional trailing `id` parameter (default: generate internally,
   unchanged for every existing caller). Caught by a failing test
   (`validateTokenAndGetUser` returning `null` right after `register`)
   before being traced to the JWT's `sessionId` claim not matching the
   session DynamoDB actually stored under.
2. **No storage primitive for `user_oauth_identities`, D1's
   multi-provider-linking table.** Flagged in
   `docs/aws-dynamodb-schema.md` as "still worth modeling for whenever
   multi-provider linking is ported" -- that's now. Added
   `OAuthIdentityStore` to `aws/db-identity` (`link`, `refreshEmail`,
   `findByProviderIdentity`, `listForUser`, `unlink`), tested with 6
   tests there, then used here for identity-first OAuth resolution and
   account linking.

## Three deliberate interface simplifications

None of these change the security-relevant logic, only how the caller
talks to it:

1. **No HTTP-cookie handling.** The original reads the OAuth CSRF nonce
   cookie itself (`readOAuthNonceCookie(request, env)`, whose cookie
   name differs dev vs. prod). This package has no HTTP layer of its
   own, so `handleOAuthCallback`/`completeOAuthLink` take the
   already-extracted cookie nonce value as a plain string parameter
   instead. The CSRF check itself -- stored nonce must exist and match
   the cookie's -- is unchanged.
2. **`ALLOWED_EMAIL` is a constructor option**, not read from an
   ambient Cloudflare `Env` binding.
3. **OAuth provider credentials are injected in the constructor**
   (`{ google?: {clientId, clientSecret}, github?: {...} }`) instead of
   `Env`-typed `.create(env, baseUrl)` factories called per request.

## What's ported vs. not

Ported: `register`, `login`, `logout`, `getOAuthAuthorizationUrl`,
`getPendingLinkUserId`, `handleOAuthCallback` (including the
identity-first OAuth resolution that refuses to silently take over an
existing email-registered account -- the exact account-takeover vector
the original's comments call out), `completeOAuthLink`,
`linkOAuthIdentity`, `unlinkOAuthIdentity` (refuses to remove a user's
last login method), `getUserIdentities`, `verifyEmailWithOtp`,
`resendVerificationOtp`, `getUserForAuth`, `validateTokenAndGetUser`
(cross-checks every token against its live session or API key, so
logout/revoke take effect immediately rather than at JWT `exp`), and
`SessionService.logSecurityEvent`/`getUserSecurityStatus` (unchanged
risk-scoring logic: session count over the concurrent-device limit or
more than 2/5 recent events bumps risk to medium/high, any
`session_hijacking` event forces high regardless of count). The
security-event methods depend on `vibesdk-db-audit`, wired in as an
*optional* constructor dependency (`auditTable`) -- omit it and
`logSecurityEvent` becomes a no-op while `getUserSecurityStatus`
reports a zeroed-out low-risk status, so a caller that doesn't want to
provision Table 5 isn't forced to.

Not ported:
- Cloudflare OAuth (`CloudflareConnectOAuthProvider`) -- out of scope,
  same as `aws/oauth-clients`.
- `unlinkOAuthIdentity`'s primary-provider repoint on the `users` row
  (when the removed identity was the "primary" one, the original
  repoints `provider`/`providerId` to another remaining identity for
  display/back-compat). `db-identity`'s `UserStore.updateUserProfile`
  only exposes display-field updates, not the primary-provider fields.
  A real gap, not silently dropped -- noted in the code where it would
  go.
- Lockout enforcement reading `AuthAttemptStore.countRecentFailures` --
  the original never wired this up either; `logAuthAttempt` records
  every attempt, nothing reads it back to lock an account. Ported
  exactly as faithfully unused as the original.
- HTTP-response concerns from the original `worker/utils/authUtils.ts`
  (`setSecureAuthCookies`, `extractToken`, etc.) -- belong to a
  controller/HTTP layer that doesn't exist in this package.

## Testing

43 tests, no real AWS or network access:

- `jwt.test.ts` (9): secret-strength validation (short/weak/low-entropy/
  repetitive all rejected), sign/verify round trip, tampered- and
  expired-token rejection.
- `auth-utils.test.ts` (10): `validateEmail`, the `ALLOWED_EMAIL` gate,
  and `validateRedirectUrl`'s three rejection cases (cross-origin,
  forbidden path, nested redirect parameter).
- `auth-orchestrator.test.ts` (24): full register/login/logout round
  trips, duplicate-email and weak-password rejection, the allowlist gate
  on both register and login, session revocation invalidating a live
  token, OAuth login creating a user vs. resolving an existing identity
  vs. refusing to take over an existing email account, OAuth CSRF nonce
  mismatch and state-replay rejection, account linking including
  "already linked to a different user" and "can't unlink your last
  login method," the OTP resend guard paths, and security-event risk
  scoring (low/medium/high escalation, immediate high on a hijacking
  event, zeroed status when constructed without `auditTable`). GitHub
  responses are mocked via `vi.stubGlobal('fetch', ...)`, same pattern
  as `oauth-clients`'s own tests; password hashing, JWT signing, and
  OAuth CSRF token generation all run for real (no crypto mocking).

## Build

```
npm install   # resolves the four file: dependencies as symlinks
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet -- same as the other `aws/*` packages.
This is the last piece: every storage, crypto, and OAuth primitive
`AuthService` depended on, plus the orchestration layer itself, is now
ported and tested.
