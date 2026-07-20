# Handoff: vibesdk AWS migration

Read this first when picking this work back up in a new session or on a
new machine. It's the "where things stand and what to do next" doc —
architecture and rationale live in the two design docs it links to, not
here.

## Where the code is

- Repo: `FrancisTremain/vibesdk` (fork of `cloudflare/vibesdk`)
- Branch: `claude/vibesdk-aws-migration-rkaasb` — all work described below
  is committed and pushed there. Nothing is stashed or local-only.
- Everything AWS-related lives under `aws/` (14 TypeScript packages plus
  `aws/infra/`'s Terraform) and `docs/aws-migration-*`. Nothing outside
  those paths has been touched — vibesdk's existing Cloudflare-based
  application code is untouched and still the deployed product.

## Standing ground rules (do not relitigate these)

- **vibesdk owns 100% of its own AWS infrastructure.** A separate
  reference platform ("Dark Factory" / vibe-platform) was used for
  architectural inspiration only (ABAC-tagging style, cost-conscious
  Spot/on-demand defaults) — never as a code or infra dependency. Never
  commit vibesdk infra/code into that other repo.
- **Hard cost constraint: under $100/month**, ideally much lower. This is
  why the design is Lambda-first / on-demand-Fargate rather than
  standing warm pools — see the technical design doc's "Cost budget" and
  "Rejected: standing warm-pool architecture" sections for the reasoning
  already worked through.
- Default posture on this branch has been "keep going autonomously,
  make reasonable product/architecture calls, only stop for (a) missing
  AWS credentials/deploy access or (b) a decision only the user can
  make." Continue in that spirit unless told otherwise.

## What's actually built vs. staged vs. blocked

**Built, tested, and committed** (14 `aws/*` TypeScript packages —
identity/auth/apps/analytics/model-config storage, auth orchestration,
crypto, OAuth clients, rate-limit, git-storage, secrets-vault, plus the
three Lambda handler packages and the actor-spike): all have passing
test suites and READMEs. Run `npm run typecheck && npm run test` inside
any `aws/<package>/` to re-verify. See docs/aws-migration-technical-design.md
section "Phased plan" for exactly which product surface each maps to.

**Staged, not yet applied** — `aws/infra/` (Terraform). This is the
"first deployable cut": 6 DynamoDB tables, the git-storage S3 bucket,
and three real API Gateway + Lambda surfaces (auth, apps,
user/stats/model-config). `terraform fmt` is clean; every variable
reference and resource name has been manually cross-checked. **Never
run through `terraform validate`/`plan`/`apply`** — see Blockers below.
`aws/infra/sandbox/` (a separate Terraform root module, deliberately
split off) is infrastructure shape only for Phase 5's sandbox
control-plane and is explicitly not part of this first cut. Full detail
and a deployment runbook: [`aws/infra/README.md`](../aws/infra/README.md).

**Not started** — `worker/index.ts`'s remaining surface (deployments and
everything not auth/apps/stats/providers/model-config), the sandbox
control-plane protocol itself (design task, not a port — see
`aws/sandbox-contract/README.md`), and the actual cutover plan (Phase 6).

## Blockers that stopped work here (this container specifically)

Both are environment limitations of the sandboxed session this work was
done in, not product/architecture blockers:

1. **No real AWS credentials.** `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
   env vars were present but set to the literal placeholder string
   `"proxy-injected"` — confirmed non-functional via
   `aws sts get-caller-identity` → `InvalidClientTokenId`. Nothing has
   ever been applied to a real AWS account.
2. **`registry.terraform.io` blocked by this session's egress policy.**
   `terraform init` needs to fetch the `hashicorp/aws` provider from
   there; the request came back 403/407-class "Forbidden." Per this
   environment's own policy (report, don't route around), it was not
   retried or worked around. This means `terraform validate`/`plan`
   have never actually run — only `terraform fmt` (works offline) and
   manual reference-correctness checks.

**Resolving both is the very next step**, and is exactly what moving to
a local machine (or otherwise providing real credentials + open
registry access) unblocks. Once available:

```
cd aws/infra
for pkg in actor-spike auth-api-lambda apps-api-lambda user-api-lambda; do
  (cd ../$pkg && npm run typecheck && npm run test && npm run package)
done
terraform init
terraform plan     # review carefully before apply -- first real plan ever run
terraform apply
```

Full runbook, including which variables need real values first
(`public_base_url`, `jwt_secret`, optional OAuth/LLM-provider keys):
[`aws/infra/README.md`](../aws/infra/README.md#deployment-runbook-root-module).

## Where to read more

- [`docs/aws-migration-product-design.md`](aws-migration-product-design.md)
  — the "what" and "why": user-facing changes, scope, success criteria,
  decision log. Source of truth for product decisions.
- [`docs/aws-migration-technical-design.md`](aws-migration-technical-design.md)
  — the "how": architecture, AWS component mapping, cost model, the
  actor-model gap (the biggest open technical risk), phased plan.
- [`docs/aws-dynamodb-schema.md`](aws-dynamodb-schema.md) — the target
  DynamoDB schema (6 tables), checked against what the shipped `db-*`
  packages actually write.
- Every `aws/<package>/README.md` — what that package ports, what it
  deliberately doesn't, and why.

## Suggested next steps, in order

1. Get real AWS credentials + open network access to `registry.terraform.io`
   (moving to a local machine is the fastest path — supports interactive
   `aws sso login`).
2. Run the deployment runbook above for `aws/infra/`'s root module.
   This is the first time `terraform plan` will have actually run — read
   it carefully, this is also the first real validation of the whole
   Terraform stack.
3. Smoke-test the three deployed API surfaces (see runbook step 6).
4. Only after that: revisit Phase 3's actor-spike to get real
   Lambda-per-message latency numbers (the user's original framing —
   "start with Lambdas, then benchmark and decide" — is exactly this
   step), which resolves the biggest open risk in the technical design
   doc ("The actor-model gap").
5. Sandbox control-plane protocol design remains a distinct, unstarted
   product/architecture task — not a next step for infra staging.
