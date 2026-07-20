# sandbox-contract

**A contract, not an implementation.** Ported types
(`worker/services/sandbox/sandboxTypes.ts`) and a target client
interface (`SandboxServiceClient`, derived from
`worker/services/sandbox/BaseSandboxService.ts`'s abstract method
surface — "All implementations MUST support every method defined
here"). No class in this package implements `SandboxServiceClient`.

## Why this is a contract and not a port

Every other `aws/*` package in this migration ports *logic*: a
service's actual behavior, verified against real inputs and outputs
with a fake in-memory backend standing in for the real AWS resource.
The sandbox is different in kind. The original's real implementation
(`worker/services/sandbox/sandboxSdkClient.ts`) doesn't implement
`createInstance`/`writeFiles`/`executeCommands`/etc. itself — it calls
into Cloudflare's proprietary `@cloudflare/sandbox` npm SDK
(`getSandbox`/`Sandbox`), which talks to a control-plane protocol baked
into the `cloudflare/sandbox` base container image
(see [`../../SandboxDockerfile`](../../SandboxDockerfile) — `FROM
docker.io/cloudflare/sandbox:0.5.6`). That protocol — however bootstrap,
file writes, command execution, log streaming, and health checks
actually get communicated between the Sandbox SDK and the container —
isn't part of this repository and has no publicly documented
specification to port against.

Building a real AWS sandbox therefore means **designing** an equivalent
control-plane protocol and a container image that speaks it (an HTTP
or exec-based API server running inside an ECS-hosted container,
implementing bootstrap/write-files/exec-commands/get-logs/deploy), not
porting existing logic — a materially different, larger, and more
novel kind of task than everything else in this migration. Per
`docs/aws-migration-technical-design.md`'s phased plan, this is also
explicitly gated on Phase 3's real Lambda-per-message latency
measurements (this migration's actor-model spike, `aws/actor-spike/`),
which need real AWS access to produce — not something guessable from
this environment.

## What this package gives a future implementation

A concrete, typed target: the exact method signatures/return shapes
`worker/agents/core/`'s Durable Object callers actually use today
(via `BaseSandboxService`), so a future control-plane design and its
AWS client can be built against a known contract instead of
re-deriving it from the original service's callers from scratch.

Two adaptations from the original, both naming/shape only:

- `deployToCloudflareWorkers` → `deploy`, and its Cloudflare-specific
  `DeploymentTarget` parameter dropped. The confirmed product decision
  (`docs/aws-migration-product-design.md`) is that the deploy target
  itself changes to AWS on this port — there's no "deploy to Cloudflare
  Workers" case for an AWS implementation to have.
- Template listing (a static R2-backed catalog fetch, not a
  per-instance sandbox operation) and the GitHub-push integration
  (`worker/api/controllers/githubExporter/`, unexamined) are not part
  of `SandboxServiceClient` — neither actually touches a running
  sandbox instance.

## Testing

3 tests, sanity-checking the ported zod schemas parse correctly
(a bootstrap response, a recursive file-tree node, and
`InstanceCreationRequest`'s `initCommand` default) — not exercising any
sandbox behavior, since there's no implementation here to exercise.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Contract only. See `aws/infra/sandbox.tf` for the ECS infrastructure
shape this would run on (also not applied, and not wired to any real
control-plane implementation yet).
