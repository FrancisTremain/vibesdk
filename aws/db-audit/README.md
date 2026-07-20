# db-audit

DynamoDB port of `audit_logs` and `system_settings` — Tables 5 and 6 of
[docs/aws-dynamodb-schema.md](../../docs/aws-dynamodb-schema.md), the
last two tables left unbuilt once every other table's real caller had
been ported.

## Why these two are small

- **`audit_logs`** has exactly one real caller in the whole codebase:
  `SessionService.logSecurityEvent` (write) and
  `SessionService.getUserSecurityStatus` (read), both scoped to
  `entityType: 'session'` rows. `AuditLogStore` here is a general
  entity-audit-trail primitive (`record`/`listForEntity`/`listForUser`),
  not narrowed to sessions specifically, since the schema itself isn't
  session-specific — but the only thing that calls it today is that one
  `SessionService` pair, now wired up in
  [`aws/auth-orchestration`](../auth-orchestration/).
- **`system_settings`** has *no* real caller anywhere in
  `worker/database/services/`. The only reference in the codebase
  (`worker/database/database.ts`) is a health-check probe
  (`select().from(systemSettings).limit(1)`) — no CRUD service exists
  for it. `SystemSettingsStore` is kept intentionally minimal
  (`get`/`set` on a key) rather than inventing an API surface nothing
  currently calls.

## By-user index is eventually consistent, and that's fine here

`AuditLogStore.listForUser` queries the `by-user` GSI (`gsi1pk=userId`,
`gsi1sk=createdAt`) designed in the schema doc. GSIs are eventually
consistent in DynamoDB — wrong for the identity table's uniqueness
lookups (which use dedicated strongly-consistent items instead, see
`aws/db-identity`'s README), but fine here: "show this user's recent
security events" tolerates a few seconds of replication lag in a way
"does this email already exist" does not. The schema doc calls this
out explicitly.

## Testing

7 tests, no real AWS or DynamoDB: recording and listing entries for one
entity, the by-user GSI query sorted most-recent-first, bounding
`listForUser` to events after a cutoff, confirming a `userId: null`
entry (D1's `onDelete: 'set null'` on `audit_logs.user_id`) doesn't
appear in the by-user index (there's no `userId` to index by), and
`SystemSettingsStore`'s get/set round trip including that updating a
setting without a description preserves the previous one.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not wired into anything real yet on its own, but its two consumers
(`SessionService.logSecurityEvent`/`getUserSecurityStatus`) are ported
in `aws/auth-orchestration`, which depends on this package the same way
it depends on `aws/db-identity` et al.
