# Root stack: the actor-model spike (Phase 3) plus the first deployable
# cut of the stateless surface port (Phase 4) -- the six application
# DynamoDB tables, the git-storage S3 bucket, and three real API
# Gateway + Lambda surfaces (auth, apps, user/stats/model-config). See
# docs/aws-migration-technical-design.md.
#
# Deliberately self-contained: no VPC attachment, no shared ALB/ECS
# cluster. Every Lambda here talks to DynamoDB and API Gateway
# Management over the AWS network directly, no VPC/egress-proxy
# plumbing needed. `aws/infra/sandbox/` is a genuinely separate root
# module (own state, own backend key) for exactly this reason -- see
# its own header comment for why it can't share this stack's apply
# lifecycle.
#
# This repo owns its own AWS infrastructure end to end. It borrows
# architectural patterns from the Dark Factory platform design (ABAC
# tagging, blue-green app hosting shape, cost-conscious defaults) but
# does not depend on or provision into that platform's Terraform state —
# this stack is self-sufficient.
#
# STATUS: `terraform fmt` clean and every var.* reference manually
# cross-checked against its declaration. `terraform validate`/`plan`
# could NOT be run -- `terraform init` needs to fetch the AWS provider
# from registry.terraform.io, which this environment's egress policy
# blocks. Needs a real `terraform init`/`plan` review and human sign-off
# on the IAM/network-facing pieces before any apply -- see this
# directory's README for the deployment runbook.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Backend config can't reference variables (a Terraform limitation,
  # not a choice) -- kept literal, in sync with var.aws_region's default.
  backend "s3" {
    bucket       = "vibesdk-terraform-state"
    key          = "aws-migration/root/terraform.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "vibesdk"
    }
  }
}

data "aws_caller_identity" "current" {}

# Lets `terraform apply` run without a `-var jwt_secret=...` on every
# invocation -- once seeded (see aws/infra/README.md), the secret lives in
# SSM instead of being retyped/re-exposed in each CloudShell session's
# shell history. var.jwt_secret still takes precedence when explicitly
# passed, so a real secrets-pipeline migration later doesn't need this
# data source removed first.
data "aws_ssm_parameter" "jwt_secret" {
  name            = "/vibesdk/jwt_secret"
  with_decryption = true
}

# Same reasoning as data.aws_ssm_parameter.jwt_secret above -- lets a plain
# `terraform apply` avoid silently blanking these back to var.*'s empty
# default (which would break the deployed sandbox integration) whenever
# they aren't explicitly passed.
data "aws_ssm_parameter" "sandbox_orchestrator_endpoint" {
  name = "/vibesdk/sandbox_orchestrator_endpoint"
}

data "aws_ssm_parameter" "sandbox_orchestrator_secret" {
  name            = "/vibesdk/sandbox_orchestrator_secret"
  with_decryption = true
}

# Same reasoning as the sandbox_orchestrator_* data sources above.
# Requires aws/infra/harness to have been applied at least once and
# its outputs (harness_orchestrator_api_endpoint,
# harness_orchestrator_secret) seeded into SSM first -- see
# aws/infra/README.md's apply-order note. aws/agent-runtime's
# ./harness-generation.ts also needs the sandbox module's own
# controlplane secret directly (not proxied through
# aws/sandbox-orchestrator-lambda for every harness tool call), hence
# sandbox_controlplane_secret alongside the two harness_orchestrator_*
# parameters.
data "aws_ssm_parameter" "harness_orchestrator_endpoint" {
  name = "/vibesdk/harness_orchestrator_endpoint"
}

data "aws_ssm_parameter" "harness_orchestrator_secret" {
  name            = "/vibesdk/harness_orchestrator_secret"
  with_decryption = true
}

data "aws_ssm_parameter" "sandbox_controlplane_secret" {
  name            = "/vibesdk/sandbox_controlplane_secret"
  with_decryption = true
}
