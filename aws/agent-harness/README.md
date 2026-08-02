# agent-harness

Control-plane HTTP server that runs inside the harness Fargate task
([`aws/infra/harness`](../infra/harness/)) and wraps the [Claude Agent
SDK](https://code.claude.com/docs/en/agent-sdk)'s `query()` in
streaming-input mode as the phased code-generation engine -- the
"codex app server equivalent" this migration's `#10` backlog item
settled on, replacing the original Cloudflare Worker's SCOF
streaming-parser pipeline (which existed to solve a
Workers-specific stream-to-browser problem that doesn't apply on
Lambda/Fargate).

## Why a separate task, not inside the sandbox

The Agent SDK spawns the real Claude Code CLI as a child process
(bundled as a platform-specific native binary,
`@anthropic-ai/claude-agent-sdk-linux-x64` on Fargate's default
x86_64 architecture). Running that loop inside the sandbox container
itself would mean a runaway or buggy agent turn could take down the
same process serving the live preview and holding command/file state.
Instead, the harness runs as its own disposable Fargate task
([`aws/infra/harness`](../infra/harness/main.tf)) with no local
filesystem relationship to the generated project at all -- every
mutation is proxied to the target sandbox task's
[`aws/sandbox-controlplane`](../sandbox-controlplane/) server over its
public IP via `./src/sandbox-client.ts`. A crash here costs a task
restart, not a corrupted sandbox.

## Tool wiring

`query()` is created with `tools: []`, disabling every built-in tool
(Bash, Write, Edit, Read, Glob, Grep -- all of which would otherwise
touch this container's own filesystem). In their place,
`./src/tools.ts` registers five custom tools via `createSdkMcpServer`:

- `write_file` / `read_file` -- proxy to the sandbox's `POST/GET /files`
- `run_command` -- proxies to `POST /commands`
- `run_static_analysis` -- proxies to `POST /analysis`
- `report_phase(name, status)` -- the *only* phase-progress signal.
  The tool handler has direct closure access to the session's phase
  state, so no `PostToolUse` hook is needed to observe it (the SDK's
  hooks do support tool-name-scoped `matcher`s, which was the
  originally-planned mechanism, but a custom tool can just update
  state in its own handler -- simpler).

## Streaming-input session model

One `HarnessSession` per container (`./src/session.ts`), backed by a
long-lived `AsyncMessageQueue` fed as `query()`'s `prompt`. This is
what makes iteration work: `sendMessage()` on a follow-up chat turn
pushes onto the same queue rather than starting a new `query()`, so
the conversation, custom tools, and phase state all carry over with no
restart. See
[`aws/harness-orchestrator-lambda`](../harness-orchestrator-lambda/)
for the 10-minute sliding idle timeout that eventually tears the task
down anyway (idle Fargate capacity still costs money) and the
`resume`-based relaunch that brings a session back later using the
Agent SDK's own `options.resume` session id.

**`/start` and `/message` do not block until a turn finishes.** A real
generation turn can run for minutes -- far longer than any HTTP or API
Gateway timeout in front of this container (API Gateway's own
integration timeout is hard-capped at 30s). Both routes return as soon
as the turn is *accepted* (the session id is known, which happens
within a second or two of the CLI subprocess starting); the caller
polls `GET /status` for phase progress and completion, exactly the
shape `aws/harness-orchestrator-lambda`'s own status route already
expects.

## Control-plane contract

Same shared-secret-header pattern as `aws/sandbox-controlplane`
(`X-Controlplane-Secret`, `aws/infra/harness/main.tf`'s
`harness_controlplane_secret`):

| Route | Body | Behavior |
|---|---|---|
| `POST /start` | `{ userPrompt, sandboxControlUrl, sandboxControlSecret, resumeAgentSessionId? }` | Starts (or resumes) the session. Returns once the session id is known. |
| `POST /message` | `{ content }` | Pushes a follow-up user turn into the still-open session. Returns immediately. |
| `GET /status` | -- | `{ agentSessionId, phase, done, error }` |
| `POST /shutdown` | -- | Closes the session gracefully, returns the final status (including the resume id), then exits the process. |

## Testing

12 tests (`tools.test.ts`, `session.test.ts`), no real Anthropic API
calls: `tools.test.ts` exercises each tool's handler directly against
a faked `SandboxClient`; `session.test.ts` fakes the entire
`@anthropic-ai/claude-agent-sdk` module (a minimal `FakeQuery` that
reads the streaming prompt and emits a session id + result per turn)
to verify `start()` resolves without waiting for the turn, `done`
flips correctly across multiple turns, and `shutdown()` returns the
final status.

## Build

```
npm install
npm run typecheck
npm run test
```

No bundling step -- the container runs `src/server.ts` directly via
`tsx` (see `Dockerfile`), the same "run source, don't bundle" choice
`aws/sandbox-controlplane` makes with Bun, avoiding any risk of
esbuild interfering with how the Agent SDK's optional native-binary
dependency resolves itself at runtime.

## Status

Not deployed. Typechecked and unit-tested against fakes; never run
against the real Anthropic API or a real Fargate task. Terraform (ECS
task definition, IAM, security group, DynamoDB session table, the
orchestrator Lambda + idle sweep) is in
[`../infra/harness`](../infra/harness/) and
[`../harness-orchestrator-lambda`](../harness-orchestrator-lambda/).
