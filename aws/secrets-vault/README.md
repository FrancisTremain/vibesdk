# secrets-vault

DynamoDB-backed secrets vault — storage, session lifecycle, and
decryption — replacing `UserSecretsStore`, per
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md)
decision 4. Port of
[`worker/services/secrets/UserSecretsStore.ts`](../../worker/services/secrets/UserSecretsStore.ts)'s
storage/session/crypto core.

## The one place this migration is an improvement, not just a workaround

Every other port in this repo (`actor-spike`, `git-storage`,
`rate-limit`) is working around something the Durable Object model gave
for free. This one is different: the original holds `encryptedVMK`
*and* the session key (`sk`) together in one DO's memory for a session's
lifetime — safe there specifically because DO memory is never persisted.
Under the (rejected) Fargate-pool draft of this migration, preserving
that would have meant pinning a session to one worker process for its
whole lifetime.

This class never persists `sk` anywhere, not even in DynamoDB. Only
`encryptedVMK` + its nonce persist (safe: ciphertext, TTL'd to
`SESSION_TIMEOUT_MS`). Every operation that needs to actually decrypt
something (`requestSecret`) takes `sessionKey` as a parameter on that
call — the eventual Lambda handler gets it from the client's request,
not from anything stored here. It's used in-memory for one call and
discarded. The "DB dump = useless encrypted blobs" property holds
exactly as strongly as the original, and there's no worker-pinning
requirement to make it true. See the module-level comment in
`src/vault-store.ts` for the full reasoning, and the
`'never persists the session key in storage'` test for the property
verified directly.

## Not ported

- The WebSocket ticket manager (`storeWsTicket`/`consumeWsTicket`) —
  Cloudflare WS-upgrade-specific connection auth. Its AWS equivalent
  (an API Gateway WebSocket `$connect` authorizer) is a different
  mechanism needing its own design, not a storage/crypto concern.
- The literal WebSocket message-routing handlers (`handleStoreSecret`
  etc.) — API Gateway/Lambda glue that calls into this class, same
  scoping choice as `aws/actor-spike` and `aws/git-storage`: this is the
  reusable, testable core, not the wire protocol on top of it.

## Storage layout

Single table, `PK: USER#<userId>`:

| Item | SK |
|---|---|
| Vault config (KDF params, verification blob, recovery codes) | `VAULTCONFIG` |
| Active session (`encryptedVMK` + nonce only — never the session key) | `VAULTSESSION`, TTL'd |
| Secret | `SECRET#<id>` |

## Testing without real DynamoDB

`src/fake-dynamo.ts` is a small in-memory stand-in, same rationale as
the other packages' fakes — no local DynamoDB was available. 19 tests
cover vault lifecycle, session expiry (including sliding-expiry
refresh-on-touch), full secret CRUD, storage-limit rejection, and a
genuine end-to-end crypto round trip using real Web Crypto AES-GCM
(generate VMK/SK, encrypt VMK with SK, encrypt a secret value with VMK,
`requestSecret` with the correct session key decrypts it; the wrong key
fails cleanly).

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/vault-store.js
```

## Status

Not wired into anything real yet — same as the other `aws/*` packages.
Needs a real DynamoDB table and the API Gateway/Lambda glue this class
is meant to sit behind.
