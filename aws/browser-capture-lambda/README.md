# browser-capture-lambda

API Gateway HTTP API (v2) Lambda: one route, `POST /api/browser/capture`
— navigates to a URL (a running sandbox preview, typically), takes a
screenshot, and returns whatever console output happened during the
page load. Replaces CF's `BROWSER` binding (`@cloudflare/puppeteer`)
used by `worker/agents/core/codingAgent.ts`'s
`captureScreenshot`/`captureBrowserConsoleLogs`.

## Why Playwright, not agentic computer-use

Considered and rejected: driving an agentic computer-use tool (a
model deciding mouse/keyboard actions against a virtual desktop
screenshot) to do this instead of hand-rolled browser automation.
Wrong shape for the job — `captureScreenshot(url, viewport)` is a
deterministic "load this exact URL, grab a screenshot and the console
output" operation, not an open-ended interaction. Computer use adds a
model call (and its cost/latency/non-determinism) per action for
something that's one `page.goto()` + `page.screenshot()` away, and it
has no programmatic console-log capture at all — you'd only see
console output if it were visibly rendered on screen. Real headless
Playwright is faster, cheaper, and gives exactly what the review/debug
loop actually consumes.

## Why the Chromium binary isn't in this Lambda's own zip

`@sparticuz/chromium` and `playwright-core` are both marked
`--external` in the esbuild bundle (`package.json`'s `build` script) —
this function's own deployment package is ~4KB. The Chromium binary
(tens of MB) needs to come from a separately-built and -published
Lambda Layer instead, providing both packages under
`/opt/nodejs/node_modules/` at runtime. That layer is **not built by
this package** — building/publishing it is a real AWS step (matching
this migration's established pattern for anything that needs an
actual artifact pushed to AWS, e.g. `aws/sandbox-container`'s Docker
image) that needs real AWS access this environment doesn't have. See
[`../infra/browser-capture.tf`](../infra/browser-capture.tf)'s
`chromium_lambda_layer_arn` variable (no default) for where that layer
gets wired in once it exists.

## Design

- `./capture.ts` — the real capture logic, structured against
  `BrowserLike`/`PageLike` (the small subset of Playwright's real
  `Browser`/`Page` it actually calls) instead of importing
  `playwright-core` directly, so it's unit-testable without a real
  Chromium.
- `./browser.ts` — the one real, untested-by-necessity piece: launches
  actual Chromium via `@sparticuz/chromium`'s bundled/managed binary
  path and `playwright-core`.
- `./screenshot-storage.ts` — uploads the PNG to a private S3 bucket
  (`aws/infra/browser-capture.tf`'s `aws_s3_bucket.screenshots`, block-
  public-access + a short lifecycle rule — these are ephemeral debug
  artifacts, not durable state) and returns a presigned GET URL
  (1h TTL).
- `./handler.ts` — auth (`X-Browser-Capture-Secret` header, same
  shared-secret pattern as `aws/sandbox-orchestrator-lambda`'s own
  caller auth — this Lambda's caller, `aws/agent-runtime`, has no
  static egress IP either), request validation, and wiring the above
  together.

## Testing

11 tests, no real Chromium and no real AWS: `capture.test.ts` runs the
real navigate/screenshot/console-capture logic against a fake
`BrowserLike`/`PageLike` (default vs. custom viewport, `waitSeconds`
delaying the screenshot, the browser closing even when navigation
throws); `screenshot-storage.test.ts` covers the S3 upload + presigned
URL against `aws-sdk-client-mock`; `handler.test.ts` covers auth,
request validation, a full success response, and a capture failure
returning 502, with `capture`/`browser`/`screenshot-storage` mocked at
the module level.

## Build

```
npm install
npm run typecheck
npm run test
npm run build     # -> dist/handler.js (tiny -- chromium/playwright-core stay external)
npm run package   # -> browser-capture-lambda.zip
```

## Status

Not deployed — needs the Chromium Lambda Layer built and its ARN set
(see above) before `terraform apply` produces a working function, even
though `terraform validate` passes today. Wired into
[`aws/agent-runtime`](../agent-runtime/)'s `capture_screenshot`
message (`./browser-capture-client.ts` in that package).
