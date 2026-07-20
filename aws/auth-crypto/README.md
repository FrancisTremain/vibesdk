# auth-crypto

Port of `PasswordService` (`worker/utils/passwordService.ts`) and
`validatePassword` (`worker/utils/validationUtils.ts`) — password
hashing/verification and strength validation. Pure crypto/logic, no AWS
SDK dependency, no DynamoDB table of its own. One piece of what an
eventual `AuthService` port needs underneath it; see
[`aws/db-auth-flows`'s README](../db-auth-flows/README.md) for why that
orchestration layer as a whole wasn't rushed into.

## The one required change

Everything here is standard Web Crypto (`crypto.subtle.deriveBits` for
PBKDF2, `crypto.getRandomValues` for the salt), supported identically on
Node 20 and Cloudflare Workers — except the original's timing-safe hash
comparison, which uses `crypto.subtle.timingSafeEqual`. That's a
Cloudflare Workers extension to Web Crypto, not part of the Web Crypto
standard, and not available in Node's `crypto.subtle`. Node has the same
guarantee (constant-time comparison, independent of where the inputs
first differ) as `timingSafeEqual` in the built-in `node:crypto` module
instead. Swapped import, not a behavior change.

`PasswordCrypto.hash`/`verify` and the PBKDF2 parameters (100,000
iterations, SHA-256, 16-byte salt, 32-byte key) are otherwise unchanged
from the original.

## `validatePassword`

Copied as-is from `worker/utils/validationUtils.ts`, including its Zod
schema (min 8 / max 128 chars, requires lower/upper/digit) and its
score/suggestions heuristics. The original signature also took unused
`_config`/`_userInfo` parameters (dead code — every call site in
`worker/database/services/AuthService.ts` passes neither); dropped here
rather than ported forward.

## Not included

- `worker/utils/validationUtils.ts`'s other exports (`validateEmail`,
  `validateUsername`, etc.) — not part of `PasswordService`, not examined.
- OAuth provider clients (`worker/services/oauth/base.ts`,
  `worker/services/oauth/github.ts`) — confirmed portable in the same
  investigation that led to this package, not yet ported.
- `AuthService`'s orchestration itself (register/login/OAuth callback
  flows) — depends on this package, `db-identity`, `db-auth-flows`, and
  the OAuth clients together; not built yet.

## Testing

15 tests, no mocking needed — genuine PBKDF2 round trips via Node's real
Web Crypto implementation, not stubbed:

- `password-crypto.test.ts`: hash/verify round trip, wrong-password
  rejection, salt randomization (same password hashes differently each
  call), and fail-closed behavior on malformed/truncated/empty stored
  hashes (returns `false`, never throws).
- `validation.test.ts`: each requirement's rejection message, scoring,
  and suggestion generation.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
