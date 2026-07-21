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
