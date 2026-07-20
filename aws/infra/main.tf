# Phase 3 actor-model spike (see docs/aws-migration-design.md).
#
# Deliberately self-contained: no VPC attachment, no shared ALB/ECS
# cluster. Lambda talks to DynamoDB and API Gateway Management over the
# AWS network directly, so no VPC/egress-proxy plumbing is needed for
# this piece. That keeps this spike testable in isolation, per the
# design doc's Phase 3 scoping.
#
# This repo owns its own AWS infrastructure end to end. It borrows
# architectural patterns from the Dark Factory platform design (ABAC
# tagging, blue-green app hosting shape, cost-conscious defaults) but
# does not depend on or provision into that platform's Terraform state —
# this stack is self-sufficient.
#
# NOT APPLIED. Written without a local `terraform` binary available to
# run `terraform validate`/`fmt` — needs both, plus human review, before
# any apply.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket       = "vibesdk-terraform-state"
    key          = "aws-migration/actor-spike/terraform.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "ap-southeast-2"

  default_tags {
    tags = {
      Project = "vibesdk"
    }
  }
}

data "aws_caller_identity" "current" {}
