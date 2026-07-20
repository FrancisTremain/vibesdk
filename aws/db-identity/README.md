# db-identity

DynamoDB port of `UserService`, `ApiKeyService`, and the storage layer
of `SessionService` — the identity slice of D1 — against the
`vibesdk-identity` table designed in
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md).
Ports [`worker/database/services/UserService.ts`](../../worker/database/services/UserService.ts),
[`worker/database/services/ApiKeyService.ts`](../../worker/database/services/ApiKeyService.ts),
and the storage half of
[`worker/database/services/SessionService.ts`](../../worker/database/services/SessionService.ts)
(509 lines — `session-store.ts`, added after the first three; see its
own module comment for what's excluded and why).

Shared key-building helpers live in `keys.ts`, used by both
`identity-store.ts` and `session-store.ts` since they operate on the
same table.

## What building this changed about the schema design

Writing the actual code found a real gap in the paper design: the
schema doc modeled hash-based lookups for the hot auth paths
(`SESSTOKEN#...`, `APIKEYHASH#...`) but missed that
`UserService.findValidSession(sessionId)` and
`ApiKeyService.getApiKeyById(keyId)` both look up by the entity's own
ID directly, with no `userId` available to the caller at that point.
Two more lookup item types (`SESSIONID#<id>`, `APIKEYID#<id>`) fix
this — see the schema doc, updated to match. This is exactly the value
of building real code against a design instead of stopping at the
design: a gap like this doesn't surface until something tries to call
the method that needs it.

## Uniqueness without a UNIQUE constraint

D1's `users.email`/`users.username`/`api_keys.key_hash` columns are
each backed by a real SQL unique index. DynamoDB has nothing equivalent
across separate items. `createUser`, username reassignment, and
`createApiKey` all use `TransactWriteItems` with `attribute_not_exists`
conditions on the relevant lookup item(s) instead — this is what
actually prevents two concurrent registrations from claiming the same
email or username, not an application-level pre-check (which would be
racy on its own). The "duplicate email/username rejected atomically,
with the whole transaction rolled back, not a partial write" tests
verify this directly.

## Not ported

- `UserService.getUserStatisticsBasic` — the one method that queries
  the `apps` table, which depends on `AppService`'s own DynamoDB port
  (not part of this package).
- `UserService.cleanupExpiredSessions` — replaced by DynamoDB TTL on
  the session item, same pattern as `aws/rate-limit` and
  `aws/secrets-vault`.
- `findUser`'s combined multi-criterion AND lookup — simplified to
  "exactly one of id/email/provider, with id-then-email-then-provider
  precedence if more than one is somehow given." Real call sites pass
  exactly one criterion; the original's flexible combination was never
  exercised with more than one filled in as far as this port's callers
  go.
- `SessionService.createSession`'s JWT logic (`JWTUtils`, token
  hashing) — application/crypto logic that belongs to the caller;
  `UserStore.createSession` already covers the storage half.
  `SessionService.logSecurityEvent`/`getUserSecurityStatus` — both
  depend on the `audit_logs` table (Table 5 of the schema doc), which
  has no package built against it yet. Excluded rather than faked.

## Testing without real DynamoDB

`src/fake-dynamo.ts` is an in-memory stand-in, same rationale as the
other `aws/*` packages' fakes — no local DynamoDB was available. This
one is the most involved of the fakes so far, since it has to simulate
real `TransactWriteItems` all-or-nothing semantics (check every
condition first, only apply writes if none failed) rather than just
single-item Put/Update/Delete. 32 tests total: 20 for user creation and
lookup, username reassignment and its uniqueness guarantee, AI Gateway
preference defaulting, session creation/lookup/expiry, and API key CRUD
including hash-uniqueness enforcement; 12 more for session revocation
(single, all, by-ID-only), active-session listing sorted by recency,
the 5-session-per-user cleanup policy, and force-logout-all-other-
sessions.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
Needs a real DynamoDB table and whatever calls `UserService`/
`ApiKeyService` today rewired to call this instead.
