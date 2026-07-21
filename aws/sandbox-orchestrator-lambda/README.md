# sandbox-orchestrator-lambda

API Gateway HTTP API (v2) Lambda implementing
[`aws/sandbox-contract`](../sandbox-contract/)'s `SandboxServiceClient`
(the abstract method surface of
`worker/services/sandbox/BaseSandboxService.ts`) for the AWS sandbox.
Drives ECS `RunTask`/`DescribeTasks`/`StopTask` against
[`aws/infra/sandbox`](../infra/sandbox/)'s Fargate cluster, tracks the
`instanceId -> task ARN / public IP` mapping in the
`vibesdk-sandbox-instances` DynamoDB table (this Lambda is stateless
between invocations), and proxies per-instance calls to the right
task's [`aws/sandbox-controlplane`](../sandbox-controlplane/) server.

## Why a Lambda calls out to a public IP instead of living in the VPC

Not attached to the sandbox VPC — avoids ENI cold-start latency on
every invocation, and keeps this Lambda's own IAM/network shape
simple. That means it has no static egress IP, which shapes two
decisions:

1. Sandbox tasks get `assign_public_ip = true` (no ALB, see
   `aws/infra/sandbox/main.tf`'s header comment for the cost
   reasoning) and this Lambda calls `http://<task-public-ip>:8080`
   directly, resolving the IP itself via `ecs:DescribeTasks` +
   `ec2:DescribeNetworkInterfaces` after a task reaches `RUNNING`.
2. Both directions of this Lambda's own trust boundary are header-secret
   authenticated rather than source-IP restricted: it authenticates to
   each sandbox task with `X-Controlplane-Secret` (`CONTROLPLANE_SECRET`,
   provisioned by `aws/infra/sandbox`), and its own caller (the
   not-yet-built code-generation orchestration layer) must send
   `X-Orchestrator-Secret` (`ORCHESTRATOR_SECRET`) — same pattern as
   `aws/infra`'s CloudFront -> Lambda `X-Origin-Verify` header.

## createInstance flow

1. Generate `instanceId` (`crypto.randomUUID()`), launch a Fargate task
   via `ecs:RunTask` with a container override setting `INSTANCE_ID`
   (every other env var is static on the task definition).
2. Write a `PROVISIONING` row to `vibesdk-sandbox-instances`.
3. Poll `ecs:DescribeTasks` until the task is `RUNNING` with an
   attached ENI, then `ec2:DescribeNetworkInterfaces` to resolve its
   public IP. Update the row to `RUNNING` with that IP.
4. `POST /bootstrap` to the task's control-plane server (files,
   `projectName`, `initCommand`), with a few retries — the container's
   control-plane process can take a moment to start accepting
   connections right after ECS reports the task `RUNNING`.
5. Return the bootstrap result plus `previewURL: http://<ip>:3000`.

Any failure along the way marks the DynamoDB row `ERROR` (or, if
`RunTask` itself fails, no row is ever written) and returns a 502 —
this route intentionally does not retry task launches; the caller
decides whether to retry a `createInstance` call.

## Routes

`POST /api/sandbox/instances` (create), `GET /api/sandbox/instances`
(list), `GET|DELETE /api/sandbox/instances/{id}` (details / shutdown),
`GET /api/sandbox/instances/{id}/status`, and proxy-through routes for
files (`GET`/`POST`), `commands`, `logs`, `errors` (`GET`/`POST
.../clear`), `analysis`, and `deploy` — each requires the instance to
be `RUNNING` with a resolved public IP (409 otherwise) and forwards
directly to that instance's control-plane server, returning its
response body unchanged.

`initialize()` from `SandboxServiceClient` has no route — it's a
per-Durable-Object setup step in the original with no meaning for a
stateless Lambda.

## Testing

10 tests, no real AWS: orchestrator-secret auth gate, a full
`createInstance` round trip against fake ECS/EC2 clients and a fake
control-plane `fetch`, a `RunTask` failure leaving no DynamoDB row,
missing `projectName` rejected, unknown-instance 404s, a `PROVISIONING`
instance reporting `pending` without calling the control plane, a
not-yet-`RUNNING` instance getting 409 on a proxy route, a successful
`writeFiles` proxy round trip, `shutdownInstance` stopping the ECS task
and deleting the row, and an unknown route returning 404.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> sandbox-orchestrator-lambda.zip
```

## Status

Not deployed. Every route tested against fake ECS/EC2/DynamoDB clients
and a fake control-plane `fetch`; never run against a real Fargate
task. Terraform (IAM role, Lambda, its own API Gateway HTTP API) is in
[`../infra/sandbox/orchestrator.tf`](../infra/sandbox/orchestrator.tf).
