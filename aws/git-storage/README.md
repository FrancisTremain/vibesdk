# git-storage

S3-only filesystem adapter for isomorphic-git, per
[docs/aws-migration-technical-design.md](../../docs/aws-migration-technical-design.md)
decision 3. Port of
[`worker/agents/git/fs-adapter.ts`](../../worker/agents/git/fs-adapter.ts)'s
`SqliteFS` — same public interface, same 1.8MB chunking scheme, same
error semantics (`ENOENT`/`EISDIR`/`ENOTDIR`/`ENOTEMPTY`/`EEXIST`/`EPERM`
with matching `errno` codes) — the storage backend changes, the
adapter's logic doesn't.

## Key scheme

Per session, everything lives under a `keyPrefix` (e.g.
`sessions/<sessionId>/git/`):

- File content: `<keyPrefix><path>/chunk-<n>`. Chunk 0 carries the
  file's total size as S3 object metadata, since a single chunk's own
  length isn't the file's size once it spans more than one chunk.
- Directory marker: `<keyPrefix><path>/.dirmeta` (empty body). A path is
  a directory if this key exists, a file if `chunk-0` exists instead —
  mutually exclusive by construction.
- Root (`''`) is always treated as an existing directory without a real
  S3 object backing it.

`readdir` comes from S3's own key hierarchy for free: listing
`<keyPrefix><path>/` with `Delimiter: '/'` returns one level of children
as `CommonPrefixes`, whether the child is a file or a directory — no
separate parent-path index needed (this repo's design doc explicitly
decided against a DynamoDB refs table for exactly this reason).

See the module-level comment in `src/s3-fs.ts` for the two things
stated explicitly rather than left implicit: `rename` is exactly as
shallow as the original SQLite adapter (moves a path's own
chunks/marker, not a directory's children — matches today's actual
behavior, not a design goal), and `.dirmeta`/`chunk-<n>` are reserved
path-segment names.

## Testing without real S3

No AWS credentials or local S3 emulator (e.g. LocalStack) were available
in the environment this was written in — `src/fake-s3.ts` is a small
in-memory stand-in implementing only the S3 operations `S3FS` actually
calls, with real S3 semantics for the parts that matter (delimiter-scoped
listing, HeadObject 404 behavior). It exists so the test suite exercises
genuine multi-step workflows (write → read back → list → rename →
delete) against real stored state, not just "was this S3 call made with
this shape." 28 tests, `npm run test`.

This is not a substitute for testing against real S3 before this ships —
particularly multipart/large-object behavior and IAM permission edges
that a fake client can't represent. Do that once real AWS access exists.

## Public exports

`src/index.ts` (the package's `main`/`types` entry) exports `S3FS`,
`Stat`, and two factories:

- `createS3FS(bucket, keyPrefix, s3Client?)` — constructs its own
  `S3Client` internally when one isn't passed. Consumers across a
  `file:` dependency boundary (e.g. `aws/agent-runtime`) should always
  use this instead of `new S3FS(new S3Client(...), ...)` — a
  consumer's own separately-installed `@aws-sdk/client-s3` produces a
  structurally-identical but nominally distinct `S3Client` type that
  TypeScript rejects at the `S3FS` constructor. Keeping `S3Client`
  construction inside this package avoids that entirely.
- `createFakeS3FS(bucket, keyPrefix)` — same idea for tests: returns
  an `S3FS` backed by an in-memory `FakeS3Client` (also exported
  directly), so a downstream package's tests can exercise real
  multi-step git workflows without needing real S3 or fighting the
  same type-identity issue in their own test files.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Wired into [`aws/agent-runtime`](../agent-runtime/)'s `generate_all`
path (`git-commit.ts`, via `createS3FS`) and a real S3 bucket
(`aws/infra/s3.tf`'s `aws_s3_bucket.git_storage`, IAM wired in
`aws/infra/agent-runtime.tf`). Still not tested against real S3 itself
(`src/fake-s3.ts` stands in — see above) — particularly multipart/
large-object behavior and IAM permission edges a fake client can't
represent. Do that once real AWS access exists.
