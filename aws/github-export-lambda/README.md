# github-export-lambda

API Gateway HTTP API (v2) Lambda for exporting an
[`aws/agent-runtime`](../agent-runtime/) session's git history to a
real GitHub repository. Reduced port of
`worker/api/controllers/githubExporter/controller.ts` +
`worker/services/github/GitHubService.ts`'s push path.

## Flow

1. `POST /api/github/export/initiate` — `{sessionId, repositoryName,
   description?, isPrivate?, returnUrl}`. Signs a short-lived (10 min)
   JWT state token (`./state-token.ts`, same `jose`/HS256 pattern as
   the original) carrying the request, and returns a GitHub OAuth
   authorize URL (`vibesdk-oauth-clients`' `GitHubExporterOAuthProvider`
   — `public_repo`/`repo` scopes, wider than the sign-in provider's
   `read:user`/`user:email`).
2. The browser is redirected to GitHub, the user approves, GitHub
   redirects back to `GET /api/github/oauth/callback?code=...&state=...`.
3. The callback verifies the state token, exchanges the code for an
   access token, creates the target repository (or looks up the
   existing one if `createUserRepository` reports `alreadyExists`),
   pushes the session's git history to it
   (`./push.ts`, `aws/git-storage` + real `isomorphic-git` over the
   git smart-HTTP protocol via `isomorphic-git/http/node`), and
   redirects to the caller's `returnUrl` with
   `?github_export=success&repository_url=...` or
   `?github_export=error&reason=...`.

## What's not ported

- **The cached-token fast path.** The original stores a GitHub token
  on the Durable Object and skips OAuth entirely on repeat exports
  from the same session. No per-user/per-session token storage exists
  here yet — every export goes through the full OAuth redirect, every
  time. A real port would add a DynamoDB-backed token cache (TTL'd,
  same shape as `aws/secrets-vault`'s session lifecycle) and a
  `getCachedToken` check before `initiate` builds an authorize URL.
- **`checkRemoteStatus`** (diffing local commits against the remote
  before syncing) — not ported, no route for it.
- **The README deploy-button rewrite** (`modifyReadmeForGitHub`,
  replacing a `[cloudflarebutton]` placeholder with a real Cloudflare
  Workers deploy link) — doesn't apply; there's no Cloudflare deploy
  target on this stack to link to.
- **Rebuilding the repo from raw git objects**
  (`GitCloneService.buildRepository`). Not needed: the session's repo
  already exists durably in S3 (written by `aws/agent-runtime`'s
  `git-commit.ts` under the same `sessions/<sessionId>/git/` key
  prefix) — `push.ts` pushes it as-is instead of reconstructing one.

## SECURITY: no ownership check yet

The original verifies the caller owns the app
(`AppService.checkAppOwnership`) before both `initiateGitHubExport`
and completing the OAuth callback. **This Lambda has no caller-identity
verification wired in at all.** Any caller who knows a `sessionId` can
trigger an export of that session's files to a repository created
under *their own* GitHub OAuth grant (the attacker still needs to
authorize the OAuth flow themselves, so this isn't a way to read
another user's GitHub account — but it does let anyone export anyone
else's generated code to a repo of their own choosing). Not safe to
expose publicly without adding an auth check — verifying the caller's
identity against `aws/auth-orchestration` and the session's `user_id`
in `vibesdk-agent-sessions` — before this ships behind a real API
Gateway route the frontend can reach.

## Testing

28 tests, no real network: `github-repo-api.test.ts` covers repo
creation/lookup/existence-check against a fake `fetch` (including the
422-already-exists and 403-permissions error paths);
`state-token.test.ts` round-trips the JWT state, rejects a
wrong-secret token, rejects garbage input; `push.test.ts` exercises
the remote add/push/resolveRef sequence against an injected fake `git`
implementation (not a real git wire-protocol fake — see below);
`handler.test.ts` covers both routes end-to-end with
`github-repo-api`/`push`/`vibesdk-oauth-clients` mocked at the module
level: a valid initiate request, a missing-field rejection, an invalid
state token, GitHub reporting an OAuth error, a full success redirect,
the already-exists fallback path, and a push failure redirect.

`push.ts` itself is not tested against a real (or wire-protocol-faked)
GitHub HTTP endpoint — faking git's smart-HTTP protocol well enough to
exercise `isomorphic-git`'s real request/response handling was out of
scope here. The dependency-injected `git`/`fs`/`http` parameters exist
specifically so this can be swapped for a real integration test
against a throwaway GitHub repo once real AWS/GitHub access exists.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> github-export-lambda.zip
```

## Status

Not deployed, and not safe to deploy publicly yet (see the security
note above). Terraform is in
[`../infra/github-export.tf`](../infra/github-export.tf).
