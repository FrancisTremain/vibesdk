# db-auth-flows

DynamoDB storage primitives for the short-lived auth-flow state
`AuthService` manages — OAuth CSRF state, login attempt tracking,
password reset / email verification tokens, OTPs — against Table 3
(`vibesdk-auth-flows`) of
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md),
designed there but not previously validated against real code.

## Not a port of `AuthService`

[`worker/database/services/AuthService.ts`](../../worker/database/services/AuthService.ts)
is 1178 lines and is fundamentally different in kind from every other
`worker/database/services/*` file ported so far in this migration.
`register`/`login`/`handleOAuthCallback` etc. are orchestration on top
of these storage primitives plus `PasswordService` (password hashing/
verification, not examined in this package) and OAuth provider HTTP
clients (`worker/services/oauth/`, not examined either) — a materially
larger and more architecturally entangled piece of work than "replace
this self-contained class's storage backend," which is what
`aws/db-identity`, `aws/db-apps`, `aws/db-model-config`, and
`aws/db-analytics` all were. Not rushed into.

What's here is what any real `AuthService` port needs underneath it
regardless of how the orchestration layer ends up shaped: five small,
storage-only classes, each covering one D1 table.

| Class | D1 table | Key |
|---|---|---|
| `OAuthStateStore` | `oauth_states` | `OAUTHSTATE#<state>` |
| `AuthAttemptStore` | `auth_attempts` | `AUTHATTEMPT#<identifier>` |
| `PasswordResetTokenStore` | `password_reset_tokens` | `PWRESET#<tokenHash>` |
| `EmailVerificationTokenStore` | `email_verification_tokens` | `EMAILVERIFY#<tokenHash>` |
| `VerificationOtpStore` | `verification_otps` | `OTP#<email>` |

Every item carries a DynamoDB TTL matching its `expiresAt` (or, for auth
attempts, a fixed 24h window) — replacing D1's `expiresAtIdx` indexes
plus an implicit cleanup job, same pattern as every other transient-state
store in this migration.

## Notable behaviors, tested directly

- `OAuthStateStore.validateAndConsume` is one-shot: a second call against
  the same state returns `null`, rejecting CSRF replay.
- `AuthAttemptStore.countRecentFailures` queries the whole (TTL-bounded,
  naturally small) recent partition for an identifier and filters by
  timestamp client-side, rather than a `sk >= :since` range condition —
  the SK's `<epochMs>#<randomId>` suffix (needed since multiple attempts
  can land in the same millisecond) makes a clean range boundary
  awkward, and the partition is already bounded by TTL regardless.
- `PasswordResetTokenStore`/`EmailVerificationTokenStore.markUsed`
  return `false` — not an error, a value callers must check — for an
  already-used or expired token, so a caller can't accidentally treat a
  replayed reset link as valid.
- `VerificationOtpStore.findLatestValidForEmail` sorts client-side by
  `createdAt` rather than relying on `ScanIndexForward`, and falls
  through to an older still-valid OTP once a newer one is marked used —
  tested directly.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is copied from `aws/db-model-config` unchanged. 17
tests across all five stores, using `vitest`'s fake timers for
deterministic expiry/ordering — including one real bug caught while
writing them: an early draft of two OTP tests called
`vi.useRealTimers()` *before* checking expiry, which meant an `expiresAt`
computed under a fake system time set to the past (relative to this
session's real wall-clock date) looked already-expired the moment real
time resumed. Fixed by keeping fake timers active through every
assertion in a test, not just the setup.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
`AuthService`'s actual orchestration layer (register/login/OAuth
callback flows, `PasswordService`, OAuth provider clients) is still
unexamined and unported.
