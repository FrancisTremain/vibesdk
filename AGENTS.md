# AGENTS.md

## Build/Test/Lint Commands
- **Build:** `npm run build` (tsc + vite)
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run lint`
- **Test all:** `npm run test`
- **Test single file:** `npx vitest run path/to/file.test.ts`
- **Test watch:** `npm run test:watch`
- **Dev servers:** `npm run dev` (frontend), `npm run dev:worker` (backend), `npm run dev:browser` (local Chromium sidecar for the `get_browser_console_logs` think-agent tool; optional, prints a warning instead of failing if not running)

## Code Style
- **No `any` type** - find or create proper types
- **Types:** Frontend imports from `@/api-types` (single source of truth)
- **Formatting:** Prettier with single quotes, tabs (see package.json)
- **Naming:** React components `PascalCase.tsx`, utilities/hooks `kebab-case.ts`, backend services `PascalCase.ts`
- **Comments:** Explain purpose, not narration. No verbose AI-like comments. No emojis.
- **DRY:** Search for existing code before creating new. Never copy-paste.
- **Imports:** Frontend APIs in `src/lib/api-client.ts`, types in `src/api-types.ts`

## Error Handling
- Backend services return `null`/`boolean` on error, never throw in RPC methods
- Use existing error classes from `worker/utils/ErrorHandling.ts`

## Key Patterns
- **Add API endpoint:** types in `src/api-types.ts` -> `src/lib/api-client.ts` -> service in `worker/database/services/` -> controller in `worker/api/controllers/` -> route in `worker/api/routes/`
- **Add LLM tool:** create in `worker/agents/tools/toolkit/` -> register in `worker/agents/tools/customTools.ts`

## Subsystem Docs
- **Usage limits UI (top-right badge, credits banner, limit popups):** see `docs/usage-limits-ui.md`

## Async communication (Slack)

When working autonomously and you need to send the repo owner a non-blocking
update, question, or status report:

- **Post in the repo's Slack channel, not a DM.** Each repo gets its own
  channel named `#repo-<repo-name>` (e.g. `#repo-vibesdk`) in the workspace.
  If it doesn't exist yet, create it (public, no need to invite anyone else)
  before posting. Don't default to DMing the repo owner directly — a DM
  doesn't scale past one agent/session and leaves no shared history for
  future sessions or other collaborators.
- **Post as an agent identity, not as the human user.** Messages should come
  from a real Slack bot/app identity (via a Slack MCP connector with its own
  bot token), not from typing into the browser while logged in as the repo
  owner. Posting as the human is indistinguishable from them writing it
  themselves, which is misleading and makes the Slack history unreliable as
  a record of what the agent did vs. what the human said.
- **The "Claude" app already installed in this workspace is not this.** It's
  Anthropic's separate consumer *Claude for Slack* product — it only
  responds to its own `@Claude` mentions with independently-generated
  replies, and has no connection to any given coding session or agent run.
  Do not rely on it to relay agent-authored updates.
- **Current status:** no Slack MCP connector (bot token) is configured in
  this environment as of 2026-07-21, so posting as a distinct agent identity
  isn't possible yet — flag this to the user rather than silently falling
  back to DMing as them. Setting one up requires a Slack app with a
  `chat:write` bot token, connected via an MCP Slack server.
