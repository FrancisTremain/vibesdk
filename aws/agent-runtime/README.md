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
- `user_suggestion` — validates a message is present, appends it to
  `conversation_messages` and `pending_user_inputs`, persists under
  the optimistic lock.
- `clear_conversation` — resets both fields.
- `get_conversation_state` — reads them back without mutating.
- `stop_generation` — clears `should_be_generating`.
- `session_init`, `vault_unlocked`, `vault_locked` — no-ops, matching
  the original (the first is disabled upstream too; the latter two
  target a companion secrets-vault connection this slice doesn't have).
- Unknown message types — `error` response, matching the original.

Deliberately returned as an honest "not implemented" `error` response
(same pattern as `aws/sandbox-controlplane`'s `handleDeploy` 501)
rather than fabricated behavior: `generate_all`, `resume_generation`,
`deploy`, `preview`, `capture_screenshot`, `get_model_configs`,
`terminal_command`. Each depends on a piece that doesn't exist on AWS
yet — the phase-generation LLM pipeline
(`worker/agents/operations/PhaseGeneration`/`PhaseImplementation`/
`UserConversationProcessor`), the deployment manager, or screenshot
capture. `github_export` returns the same deprecation message the
original already returns (that feature moved to an OAuth redirect
flow upstream, independent of this migration).

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

## Testing

12 tests, no real AWS (`aws-sdk-client-mock`, same convention as
`aws/actor-spike`): reject connect with no `sessionId`; initialize a
new session and ack `agent_connected`; reconnecting to an existing
session doesn't overwrite it; disconnect removes the connection
record; unknown connection on `$default` 404s; `user_suggestion`
appends under the lock; a `user_suggestion` with no message text
short-circuits before touching state; a lock conflict reapplies the
mutation fresh from the re-read state, not compounded onto the stale
candidate (same property `actor-spike` tests); `clear_conversation`
resets and acks; `get_conversation_state` reads without persisting;
`generate_all` returns the not-implemented error without mutating
state; an unknown message type errors.

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
