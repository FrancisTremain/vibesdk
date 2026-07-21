# llm-client

Provider-agnostic LLM inference client: direct HTTP calls to
Anthropic, OpenAI, and Google AI Studio, no vendor SDK dependency.
This is the "own the runtime and sandbox invocations so we can be
provider agnostic" decision made concrete for the one piece that
decision is actually about -- the HTTP call to an LLM provider.

## What this is not

Not a port of `worker/agents/inferutils/core.ts` (1150 lines) or the
rest of `worker/agents/inferutils/` (~4,360 lines total across
`infer.ts`, `toolExecution.ts`, `schemaFormatters.ts`,
`loopDetection.ts`, `completionDetection.ts`). That code does a lot
more than call a provider: structured-output schema coercion and
repair, tool-calling loop orchestration with depth limits
(`getMaxToolCallingDepth`), fallback-model retry chains, loop
detection, streaming-chunk assembly. All of that still needs to be
built and will call into this package's `runInference` for the actual
HTTP request -- this package is the one real primitive underneath it,
not a replacement for it.

## Design

- `runInference(request: InferenceRequest): Promise<InferenceResponse>`
  parses `request.modelId` (`aws/model-config-defaults`'s
  `provider/model-name` convention, e.g. `anthropic/claude-sonnet-4-5`)
  and dispatches to a provider adapter (`src/providers/*.ts`).
- Each adapter is a plain HTTP call via `fetch` (injectable as
  `request.fetchImpl` for tests) and a response normalizer, no
  provider SDK: `anthropic` (Messages API), `openai` (Chat Completions),
  `google-ai-studio` (Gemini `generateContent`). An unsupported
  provider (`cerebras`, `groq`, `grok`, `google-vertex-ai` --
  all present in `aws/model-config-defaults`' provider list) throws a
  clear `InferenceError` rather than silently no-op-ing; adding one
  is a new file in `src/providers/` plus a line in
  `client.ts`'s `PROVIDER_ADAPTERS` map.
- Retry: up to 3 attempts (configurable), exponential backoff, only
  on `429`/`500`/`502`/`503`/`504`. A `400`/`401`/etc. fails fast.
  `sleepImpl` is injectable so tests don't actually wait.
- Callers resolve the API key themselves (from
  `PLATFORM_*_API_KEY` env vars, matching
  `aws/model-config-defaults`'s `byok-helper.ts` naming convention, or
  a user's own BYOK key) and pass it in `request.apiKey` -- this
  package has no credential-resolution logic of its own, same
  separation of concerns as `aws/secrets-vault`.
- System messages: extracted to Anthropic's top-level `system` field
  and Gemini's `systemInstruction`, left in place as a `system`-role
  message for OpenAI (the only one of the three whose chat API accepts
  it directly).

## Testing

10 tests, no real network: request-shape assertions for all three
providers (headers, body, system-message handling, Gemini's
`assistant` -> `model` role mapping), response normalization,
non-2xx surfaces the provider's own error message, retry-then-succeed
on a `429`, retry exhaustion on repeated `500`s, no retry on a `400`,
an unsupported provider rejects without ever calling `fetch`, and a
`modelId` containing more than one `/` (e.g. a Vertex-style
`provider/vendor/model` id) splits only on the first separator.

## Build

```
npm install
npm run typecheck
npm run test
npm run build   # -> dist/index.js
```

## Status

Not deployed as its own service -- this is a library dependency
(`vibesdk-llm-client`, `file:../llm-client`) for whichever Lambda ends
up running the phase-generation / conversation-processing pipeline on
top of `aws/agent-runtime`, once that pipeline itself is ported. Not
wired into any Lambda yet.
