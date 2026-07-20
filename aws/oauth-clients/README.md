# oauth-clients

Port of the OAuth provider HTTP clients — `BaseOAuthProvider`, plus
`GitHubOAuthProvider` and `GoogleOAuthProvider`
(`worker/services/oauth/base.ts`, `github.ts`, `google.ts`). Pure
`fetch`/`URLSearchParams`/Web Crypto, no AWS SDK dependency, no DynamoDB
table of its own. Another piece of what an eventual `AuthService`
orchestration port needs, alongside `aws/auth-crypto`,
`aws/db-identity`, and `aws/db-auth-flows`.

## What changed

Almost nothing — the originals had no Cloudflare-specific dependency
beyond two things, both adapted rather than dropped:

- **Logger**: the original imports `createLogger` from `worker/logger/`,
  which is wired into Sentry and Cloudflare request context — not
  portable, and pulling it in would drag most of the worker with it.
  Replaced with a minimal `Logger` interface (`error(message, ...args)`)
  that a caller can satisfy with `console`, their own logger, or nothing
  (defaults to a no-op). See `types.ts`.
- **Credential/env lookup**: the originals' `static create(env: Env,
  baseUrl)` read `env.GITHUB_CLIENT_ID` etc. directly from Cloudflare's
  `Env` binding type. Changed to `static create(clientId, clientSecret,
  baseUrl, logger?)` taking plain strings — the same validation
  (`throws if either credential is missing`), just without an ambient
  Workers-only type.

Everything else — PKCE (`generateCodeChallenge`/`generateCodeVerifier`),
the authorization-URL builder, token exchange/refresh, and each
provider's `getUserInfo` (including GitHub's verified-email resolution,
which deliberately never trusts `/user`'s unverified `email` field and
always resolves through `/user/emails`) — is unchanged.

## Not included

- `worker/services/oauth/cloudflare-connect.ts` and
  `github-exporter.ts` — Cloudflare-account-linking and GitHub-export
  flows, unrelated to authentication, not examined.
- `AuthService`'s orchestration itself (register/login/OAuth callback
  flows, session issuance) — depends on this package plus
  `aws/db-identity`, `aws/db-auth-flows`, and `aws/auth-crypto`
  together; not built yet.

## Testing

15 tests, no AWS or DynamoDB involved:

- `github.test.ts`: ported verbatim from
  `worker/services/oauth/github.test.ts` (the original had nothing
  Cloudflare-specific to change) — verified-primary-email selection,
  fallback to a verified non-primary email, unverified-email fail-open
  reporting (never silently upgraded to verified), and the
  no-email-resolvable error path. Plus `create()`'s missing-credentials
  check.
- `google.test.ts`: userinfo mapping, request-failure handling,
  `create()`'s missing-credentials check.
- `base.test.ts`: authorization-URL construction (with and without
  PKCE), token exchange success/failure, and PKCE code-verifier
  charset/uniqueness.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
