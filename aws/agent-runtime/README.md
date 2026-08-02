# agent-runtime

The real actor-model session runtime, built directly on
[`aws/actor-spike`](../actor-spike/)'s proven Lambda-per-WebSocket-message
plumbing (see that package's README for what it de-risked, and
`docs/aws-migration-technical-design.md`'s "actor-model gap" section
for why this shape exists at all). This is the next layer the spike's
own README pointed at: "once this answers the latency question, the
real actor logic gets built on top of the same pattern."

Same three routes, same optimistic-lock persistence
(`ConditionExpression` on `lock_version`, retry-with-fresh-reread on
conflict), same connection-routing table shape as the spike. What's
different: real session state (`./state.ts`) instead of a placeholder
counter, and real message dispatch (`./messages.ts`) instead of a
fixed increment.

## What's really ported vs. stubbed

This is **not** a full port of `worker/agents/core/codingAgent.ts` +
`websocket.ts`. Real, tested behavior:

- Session lifecycle: `$connect` loads-or-initializes a session
  (never clobbers an existing one on reconnect), `$disconnect` removes
  the connection record, matching the original's connect/disconnect
  semantics.
- `user_suggestion` — validates a message is present, calls
  [`vibesdk-llm-client`](../llm-client/) for a real single-turn
  completion over the conversation history (`./llm.ts`), appends both
  the user message and the assistant reply to `conversation_messages`
  and `pending_user_inputs`, persists under the optimistic lock, and
  responds `conversation_response` with the reply. This is **not**
  `worker/agents/operations/UserConversationProcessor.ts`'s real
  conversational-AI handling — no tool calling, no blueprint/project-
  state grounding, no streaming, just a completion with a system
  prompt that's explicit about what this runtime can't do yet. If the
  LLM call fails (no API key configured, retries exhausted), nothing
  is persisted and the failure is returned as an `error` response —
  see `handler.ts`'s `handleMessage`.
- `clear_conversation` — resets both fields.
- `get_conversation_state` — reads them back without mutating.
- `stop_generation` — clears `should_be_generating`.
- `generate_all` — **starts a phased, iterable generation session**
  via [`aws/agent-harness`](../agent-harness/), the Claude Agent
  SDK-based harness that superseded the earlier single-shot
  `./generation.ts` design (kept in the tree as a documented,
  independently-tested fallback shape, not deleted, but no longer
  wired into `generate_all` — see "Why generation moved to the Agent
  SDK harness" below). Resolves a project description (the message
  itself, else the last user turn in conversation history, else
  `state.query`), creates an empty sandbox instance via
  [`aws/sandbox-orchestrator-lambda`](../sandbox-orchestrator-lambda/),
  then starts a harness session against it
  (`./harness-generation.ts` + `./harness-client.ts`, talking to
  [`aws/harness-orchestrator-lambda`](../harness-orchestrator-lambda/)).
  **Returns as soon as the session is accepted, not once generation
  finishes** — persists `harness_session_id`, `sandbox_instance_id`,
  `preview_url`, `sandbox_control_url`, and the initial phase, and
  responds `generation_started`. The client is expected to send
  `poll_generation_status` repeatedly afterward.
- `poll_generation_status` — polls the harness's current phase via
  `./harness-client.ts`. While still running, mutates `current_phase`
  and responds `phase_update`. Once the harness reports the turn done,
  pulls the resulting files out of the sandbox
  (`./sandbox-client.ts#getSandboxFiles`), persists them as
  `generated_files`, flips `should_be_generating` off, and responds
  `generation_complete` — the same response shape `generate_all` used
  to return directly. A no-op (no state read past the connection
  lookup, no response) when no harness session has ever started for
  this chat.
- `record_activity` — a UI-activity heartbeat from the side-by-side
  editor/preview pane. Resets `aws/harness-orchestrator-lambda`'s
  10-minute sliding idle-teardown clock (`./harness-client.ts`'s
  `recordHarnessActivity`) without sending a chat turn. No state
  mutation and no response — purely a side effect, so it never
  contends with the optimistic lock a real message would.
- `user_suggestion` now branches on whether a harness session exists
  for this chat: with one, a message is a **follow-up iteration** —
  pushed into the still-open (or automatically resumed, if idle
  torn-down) harness session via `./harness-client.ts`'s
  `sendHarnessMessage`, `should_be_generating` flips back on, and the
  reply surfaces through the same `poll_generation_status` polling as
  `generate_all`. Without one, this is unchanged from the original
  single-turn `deps.generateReply` completion described above.
- `deploy` — launches a **second, independent** sandbox instance
  (`./deploy.ts`, via the same `aws/sandbox-orchestrator-lambda` call
  `generate_all` uses) from the files already persisted on state — no
  new LLM call. Persists `deployed_url`/`deployment_instance_id`,
  responds `deployment_completed`. Errors (nothing persisted) if
  `generate_all` hasn't produced anything yet. **Not** the original's
  blue-green Workers-for-Platforms deployment manager — see
  `./deploy.ts`'s module comment and "Why deploy is a second sandbox
  instance, not a real deployment pipeline" below.
- `capture_screenshot` — navigates to `data.url` via
  [`aws/browser-capture-lambda`](../browser-capture-lambda/)
  (`./browser-capture-client.ts`), a real headless-Chromium Playwright
  capture (not an agentic computer-use loop — see that package's
  README for why), and responds `screenshot_capture_success` with a
  presigned screenshot URL and captured console output, or
  `screenshot_capture_error` on failure. Doesn't mutate session state
  — a screenshot doesn't change anything about the generation.
- `session_init`, `vault_unlocked`, `vault_locked` — no-ops, matching
  the original (the first is disabled upstream too; the latter two
  target a companion secrets-vault connection this slice doesn't have).
- Unknown message types — `error` response, matching the original.

Deliberately returned as an honest "not implemented" `error` response
(same pattern as `aws/sandbox-controlplane`'s `handleDeploy` 501)
rather than fabricated behavior: `resume_generation` (there are no
phases here to resume — nothing to be "partial"), `preview` (a
live-preview force-refresh signal with no separate refresh mechanism
to trigger here), `get_model_configs` (needs `aws/model-config-defaults`
wired in — see "LLM and sandbox configuration" below), `terminal_command`.
`github_export` returns the same deprecation message the original
already returns (that feature moved to an OAuth redirect flow
upstream, independent of this migration — see
[`aws/github-export-lambda`](../github-export-lambda/) for the real
HTTP-triggered flow).

## Why generation moved to the Agent SDK harness

`worker/agents/operations/`'s real pipeline plans multiple phases,
generates and diffs files phase by phase through a custom streaming
parser (`worker/agents/output-formats/streaming-formats/scof.ts`), and
runs static analysis plus deterministic fix-ups between phases. SCOF
existed to solve a Cloudflare-Workers-specific problem — streaming
file writes character-by-character to the browser within a single
Worker invocation — that doesn't apply on Lambda/Fargate, which have
no equivalent cheap token-streaming-to-browser primitive tied to one
request.

An earlier iteration of this package (`./generation.ts`, kept in the
tree, no longer wired into `generate_all`) took the simplest possible
replacement: one LLM completion asking for a small app as a single
JSON file list, no phases, no diffing, no repair loop. That traded
away multi-file consistency on larger apps and any recovery from a
malformed response for a real, working, testable path shipped
quickly.

`generate_all` now uses [`aws/agent-harness`](../agent-harness/)
instead: a Claude Agent SDK `query()` running as its own Fargate task
(`aws/infra/harness`), with built-in tools disabled and replaced by
custom tools that proxy file/command/analysis operations to the
target sandbox. This restores real phase-by-phase progress (via the
harness's `report_phase` tool, surfaced through
`poll_generation_status`) and genuine follow-up iteration (`streamInput`-based
multi-turn sessions, not a fresh one-shot completion per message) —
the two things the single-shot design gave up — without reimplementing
SCOF, since phase progress and iteration don't depend on
character-by-character streaming the way the original's UX did.

## Why deploy is a second sandbox instance, not a real deployment pipeline

`docs/aws-migration-technical-design.md` scopes the real replacement
for the original's deployment manager (`wrangler.jsonc` +
Workers-for-Platforms dispatch) as "vibesdk's own blue-green Terraform
module for apps a user explicitly deploys long-term" — and calls that
out explicitly as "the biggest architectural change from how vibesdk
deploys today." That pipeline doesn't exist yet: no custom domains, no
blue-green cutover, no separate hosting tier from the sandbox tier.
`./deploy.ts` does the next most honest thing instead: launch a second
Fargate task through the exact same `aws/sandbox-orchestrator-lambda`
path `generate_all` already uses, so a "deployed" app has a URL that
outlives the live coding session (regenerating or closing the session
only touches `sandbox_instance_id`, not `deployment_instance_id`).
Whether that lifecycle independence holds up over time depends on
nothing else in this migration ever building idle-eviction for
sandbox tasks either — today *every* sandbox task, preview or deploy,
just runs until something explicitly calls `shutdownInstance` on it.

## Why git storage is S3, not a real git host

A real git host (GitHub/GitLab) with a service account was considered
for session storage instead of `aws/git-storage`'s S3 adapter — it
would mean not maintaining a chunked-object filesystem adapter at all,
and isomorphic-git already speaks real git HTTP transport natively.
Rejected for internal per-session storage specifically: this
migration's standing constraint is AWS-only, and every session's
generated code would otherwise depend on a third-party service being
reachable and within its rate limits for the *core* generation loop,
not just an explicit, opt-in action. A generated app's source also
shouldn't live on a third party's infrastructure by default just
because it was generated, before the user has chosen to export
anything. A real git host stays the right tool for the existing
GitHub Export feature (`worker/api/controllers/githubExporter/`,
explicit, OAuth-based, user-initiated) — that's a distinct concern
from this.

## Why git storage is best-effort

By the time `generation.ts` calls `commitGeneratedFiles`, the sandbox
task is already running with the user's files — that side effect
can't be undone, and a working preview is more immediately useful to
the user than the git history behind it. So unlike every other
mutate-and-persist path in this package (LLM failure, sandbox launch
failure: all-or-nothing, nothing persisted), a git-commit failure
doesn't fail `generate_all`. It's surfaced as `git_commit_error` on
the persisted state and in the `generation_complete` response instead
of being silently swallowed, so a real failure (bad IAM permissions,
`GIT_STORAGE_BUCKET` unset) is visible rather than hidden behind a
missing `git_commit_sha`.

## Why the state shape is reduced

`./state.ts`'s `AgentSessionState` is a deliberately narrow port of
`worker/agents/core/state.ts`'s `BaseProjectState` — session identity,
generation-control flags, and conversation history only. The full
`AgentState` union (`PhasicState`/`AgenticState`/`ThinkState`) carries
`Blueprint`, `PhaseConceptType`, and `FileOutputType` from
`worker/agents/schemas.ts`, a large zod tree tied entirely to the
not-yet-ported phase-generation pipeline. Porting those shapes now,
with no real logic here to exercise them, would mean guessing at a
schema rather than porting one — so they're left out until the
pipeline that actually produces and consumes them gets built.

Auth is similarly reduced: the original captures a Cloudflare-OAuth
identity from an HttpOnly cookie at WS-upgrade time
(`codingAgent.ts`'s `onConnect` / `readTokenCookie`). This package
accepts a `userId` query param instead — an explicit placeholder, not
a hidden gap.

## LLM and sandbox configuration

`./model.ts` reads `AGENT_MODEL_ID` (`aws/model-config-defaults`'s
`provider/model-name` id convention, default
`anthropic/claude-sonnet-4-5`) and resolves the API key from
`${PROVIDER}_API_KEY` (matching `aws/model-config-defaults`'s
`byok-helper.ts` naming), shared by `./llm.ts` and `./generation.ts`.
This is a single fixed model for every session, not the original's
real per-agent-action `AGENT_CONFIG` selection
(`worker/agents/inferutils/config.ts`) — that requires the
model-config resolution this runtime doesn't have wired in yet
(`aws/model-config-defaults` exists but isn't a dependency of this
package).

`./sandbox-client.ts` reads `SANDBOX_ORCHESTRATOR_ENDPOINT` and
`SANDBOX_ORCHESTRATOR_SECRET` — the deployed
`aws/sandbox-orchestrator-lambda` API's URL and its
`X-Orchestrator-Secret` value. `aws/infra/agent-runtime.tf` wires these
as plain Terraform variables (`var.sandbox_orchestrator_endpoint`/
`var.sandbox_orchestrator_secret`), not a `terraform_remote_state`
read of `aws/infra/sandbox`'s state — seeding them from that stack's
own outputs after it's been applied once is a manual step, deliberately,
to avoid inverting this migration's established apply order (root
stack, then the sandbox module, which itself reads the root stack's
outputs). Without them set, `generate_all` fails with a clear "not
configured" error rather than a confusing network failure.

`./harness-client.ts` reads `HARNESS_ORCHESTRATOR_ENDPOINT` and
`HARNESS_ORCHESTRATOR_SECRET` — the deployed
`aws/harness-orchestrator-lambda` API's URL and its
`X-Orchestrator-Secret` value, same manual-copy-in pattern as the
sandbox orchestrator variables above (`aws/infra/harness` applies
after the root stack, same reasoning). `./harness-generation.ts` also
reads `SANDBOX_CONTROLPLANE_SECRET` — the same cluster-wide secret
`aws/infra/sandbox` generates for its own orchestrator Lambda to
authenticate against a sandbox task's control-plane port, needed here
so the harness's custom tools can call that port directly instead of
proxying every file/command/analysis call back through
`aws/sandbox-orchestrator-lambda`. Without either set, `generate_all`
fails with a clear "not configured" error.

`./git-commit.ts` reads `GIT_STORAGE_BUCKET` — the S3 bucket
`aws/infra/s3.tf`'s `aws_s3_bucket.git_storage` provisions. Unlike the
sandbox orchestrator variables above, this doesn't need a manual
copy-in step: it's the same root stack's own resource. Missing this
doesn't fail `generate_all` — see "Why git storage is best-effort"
above.

`./browser-capture-client.ts` reads `BROWSER_CAPTURE_ENDPOINT` and
`BROWSER_CAPTURE_SECRET` — also same-root-stack resource references
(`aws/infra/browser-capture.tf`, wired directly in `agent-runtime.tf`,
no manual copy-in needed), *unlike* the sandbox orchestrator variables.
Even fully wired, `capture_screenshot` won't actually capture anything
until the Chromium Lambda Layer that package's README describes is
built and published — a real AWS step, same category as
`aws/sandbox-container`'s Docker image push.

## A note on API Gateway's 29-second WebSocket integration timeout

`generate_all` can legitimately run for minutes (LLM completion, then
`ecs:RunTask` + waiting for a public IP + bootstrap inside
`aws/sandbox-orchestrator-lambda`, see that package's own README).
API Gateway's WebSocket `$default` route integration stops waiting for
this Lambda's synchronous return value after 29 seconds (a hard AWS
ceiling, not configurable past it) — but that return value is only
used for API Gateway's own request logging, not for delivering the
response to the client. The actual message delivery is the explicit
`PostToConnectionCommand` call this Lambda makes as a side effect
before returning, which keeps working for as long as the Lambda itself
keeps running (up to its own configured timeout,
`var.agent_runtime_lambda_timeout_seconds`, default 300s) regardless
of what API Gateway's integration-timeout bookkeeping does in the
meantime. Not yet verified against a real deployment — flagged here as
a known characteristic of the design, not confirmed AWS behavior this
migration has tested.

## Testing

46 tests across seven files, no real AWS (`aws-sdk-client-mock`, same
convention as `aws/actor-spike`) and no real LLM, sandbox-orchestrator,
harness-orchestrator, S3, or browser-capture calls in `handler.test.ts`
(`./llm.ts`, `./harness-generation.ts`, `./harness-client.ts`,
`./sandbox-client.ts`, `./git-commit.ts`, `./deploy.ts`, and
`./browser-capture-client.ts` are all mocked at the module level; each
has its own real-logic tests instead — `generation.test.ts` covers the
now-unused-but-kept `./generation.ts`'s `parseGeneratedProject` JSON
validation directly, `sandbox-client.test.ts` and `deploy.test.ts`
cover their respective orchestrator HTTP calls against a fake `fetch`,
`browser-capture-client.test.ts` covers the capture-Lambda HTTP call
the same way, `git-commit.test.ts` runs real `isomorphic-git`
`init`/`add`/`commit`/`log`/`readBlob` calls against
`aws/git-storage`'s `createFakeS3FS` in-memory backend, and
`llm-client` itself is tested against a fake `fetch` in its own
package).

`handler.test.ts`: connect/disconnect/reconnect lifecycle;
`user_suggestion` calls the LLM and appends both turns under the lock
when no harness session exists yet, routes to the harness's
`sendHarnessMessage` instead once one does; a lock conflict reapplies
the mutation fresh from the re-read state; `clear_conversation` and
`get_conversation_state`; `generate_all` starts a harness session from
an explicit message (falling back to the last conversation turn, then
erroring cleanly with no description at all) and persists
`harness_session_id`/`sandbox_control_url`, responding
`generation_started` rather than waiting for the turn to finish;
errors without persisting when starting the harness session fails;
`poll_generation_status` responds `phase_update` while the harness is
still working, pulls sandbox files and best-effort-commits them to git
storage (surfacing a commit failure as `gitCommitError` without
failing the poll, same best-effort semantics generate_all always had)
once the harness reports done, and is a no-op when no harness session
has ever started; `record_activity` resets the harness idle clock
without touching session state, and is a no-op with no session;
`deploy` and `capture_screenshot` unchanged from before; an unknown
message type errors.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js
npm run package   # -> agent-runtime.zip
```

## Status

Not deployed. Terraform (its own DynamoDB tables, WebSocket API,
Lambda, IAM role) is in
[`../infra/agent-runtime.tf`](../infra/agent-runtime.tf) — separate
resources from `aws/actor-spike`'s (that stays as the throwaway
latency-measurement artifact it was built as, not repurposed).
`generate_all` and `deploy` both depend on `aws/infra/sandbox` having
been applied and its orchestrator endpoint/secret copied into this
stack's variables (see above); `capture_screenshot` depends on
`aws/browser-capture-lambda`'s Chromium Lambda Layer having been built
and published. Every other message type works without either.
