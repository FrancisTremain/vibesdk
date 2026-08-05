# ECS infrastructure shape for on-demand sandbox tasks, per
# docs/aws-migration-technical-design.md's "Sandbox + deploy port"
# (Phase 5) decisions: Fargate Spot, launched fresh per session via
# ecs:RunTask, no standing pool -- replacing CF's UserAppSandboxService
# (@cloudflare/sandbox against the `cloudflare/sandbox` container
# image, see ../../../SandboxDockerfile).
#
# The control-plane server this image runs is now real:
# aws/sandbox-controlplane (HTTP server, reuses container/cli-tools.ts
# unmodified) built into aws/sandbox-container's Dockerfile. This stack
# still needs a real pushed image URI (var.sandbox_task_image) before
# apply -- see aws/sandbox-container/README.md for the build/push steps.
#
# A SEPARATE ROOT MODULE from the rest of aws/infra, deliberately --
# see this directory's own README for why: in short, var.sandbox_task_image
# has no possible default (no image exists until built and pushed), which
# would otherwise block terraform plan/apply on the entire aws/infra stack,
# including the parts that don't depend on it. Split out so the root
# stack's apply lifecycle stays independent.
#
# No ALB. An ALB has a flat ~$16-20/mo charge whether or not a sandbox
# task is even running, which contradicts this migration's zero-idle-cost
# philosophy (Lambda-first, DynamoDB on-demand, no NAT Gateway -- see
# frontend.tf's CloudFront-Function-based IP allowlist for the same
# reasoning applied to the main site). Sandbox tasks instead get a public
# IP directly (`assign_public_ip = true`, ephemeral per task, looked up by
# the orchestrator Lambda via ecs:DescribeTasks + ec2:DescribeNetworkInterfaces
# once the task is running) and the preview URL is
# `http://<task-public-ip>:3000` -- HTTP only, no per-task TLS cert being
# practical here. Security is the same IP allowlist used everywhere else
# in this migration (var.allowed_ips), enforced directly on the task's
# security group instead of at a CloudFront/ALB edge, since there's no
# edge in front of these tasks.
#
# A Fargate task's ENI is also ephemeral and changes every task restart,
# so it can't be a stable VPC route-table target the way a NAT Gateway
# can -- confirming there's no "NAT task" shortcut available even if an
# ALB-free design didn't already avoid needing one.

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

  # Separate state file from the root stack -- this module's resources
  # are independent of (and, per above, deliberately decoupled from)
  # the root stack's apply lifecycle.
  backend "s3" {
    bucket       = "vibesdk-terraform-state"
    key          = "aws-migration/sandbox/terraform.tfstate"
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

# Reads the root stack's outputs (git_storage_bucket_arn) instead of
# requiring the operator to copy a value between applies. Assumes the
# root stack has already been applied at least once -- true for any
# real deployment sequence, since the root stack is the "first
# deployable cut" and this module always comes after it.
data "terraform_remote_state" "root" {
  backend = "s3"
  config = {
    bucket = "vibesdk-terraform-state"
    key    = "aws-migration/root/terraform.tfstate"
    region = "ap-southeast-2"
  }
}

locals {
  git_storage_bucket_arn = data.terraform_remote_state.root.outputs.git_storage_bucket_arn
}

resource "aws_vpc" "sandbox" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "vibesdk-sandbox" }
}

resource "aws_internet_gateway" "sandbox" {
  vpc_id = aws_vpc.sandbox.id
}

resource "aws_subnet" "sandbox_a" {
  vpc_id                  = aws_vpc.sandbox.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
}

resource "aws_subnet" "sandbox_b" {
  vpc_id                  = aws_vpc.sandbox.id
  cidr_block              = "10.42.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true
}

resource "aws_route_table" "sandbox_public" {
  vpc_id = aws_vpc.sandbox.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.sandbox.id
  }
}

resource "aws_route_table_association" "sandbox_a" {
  subnet_id      = aws_subnet.sandbox_a.id
  route_table_id = aws_route_table.sandbox_public.id
}

resource "aws_route_table_association" "sandbox_b" {
  subnet_id      = aws_subnet.sandbox_b.id
  route_table_id = aws_route_table.sandbox_public.id
}

# Gateway endpoints for S3/DynamoDB are free and keep that traffic off
# the public internet path even though the subnet is technically
# "public" -- sandbox tasks talking to aws/git-storage's S3 bucket or
# any DynamoDB table don't need to traverse the internet gateway.
resource "aws_vpc_endpoint" "sandbox_s3" {
  vpc_id            = aws_vpc.sandbox.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.sandbox_public.id]
}

resource "aws_vpc_endpoint" "sandbox_dynamodb" {
  vpc_id            = aws_vpc.sandbox.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.sandbox_public.id]
}

resource "aws_security_group" "sandbox_task" {
  name        = "vibesdk-sandbox-task"
  description = "Sandbox Fargate tasks -- dev server + control plane reachable only from var.allowed_ips, outbound open for package installs"
  vpc_id      = aws_vpc.sandbox.id

  ingress {
    description = "Dev server port (live preview) -- IP allowlist, same as the main site"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = var.allowed_ips
  }

  ingress {
    description = "Control-plane port (aws/sandbox-controlplane), reachable from the orchestrator Lambda ENIs and the same IP allowlist for direct debugging"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = var.allowed_ips
  }

  egress {
    description = "Package installs, LLM calls if a sandbox ever needs one, S3/DynamoDB via gateway endpoint"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # This resource's inline ingress blocks are only ever this stack's
  # original two rules; every rule added later
  # (sandbox_task_control_plane_any_source, sandbox_task_dev_server_from_alb
  # in alb.tf) is a standalone aws_security_group_rule instead, deliberately
  # -- but the AWS provider treats an aws_security_group's inline blocks as
  # authoritative over the *entire* rule set on the group, so every plan
  # otherwise proposes deleting those separately-managed rules. Ignoring
  # ingress drift here is the documented workaround for mixing both
  # management styles on one security group.
  lifecycle {
    ignore_changes = [ingress]
  }
}

# The orchestrator Lambda (aws/sandbox-orchestrator-lambda) calls each
# task's control-plane port from outside the VPC (Lambda not attached to
# this VPC, to avoid ENI cold-start latency and keep the Lambda simple) --
# so it needs its own inbound allowance. Its egress IPs aren't static
# without a NAT Gateway (which this stack deliberately avoids), so instead
# the Lambda authenticates control-plane calls with a shared secret header
# (same X-Origin-Verify pattern as frontend.tf's CloudFront->Lambda calls),
# and this rule stays scoped to var.allowed_ips only -- the orchestrator
# path relies on the secret, not source-IP, for its own authorization.
resource "aws_security_group_rule" "sandbox_task_control_plane_any_source" {
  type              = "ingress"
  from_port         = 8080
  to_port           = 8080
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.sandbox_task.id
  description       = "Orchestrator Lambda has no static egress IP without a NAT Gateway (avoided for cost) -- control-plane calls are authenticated by X-Origin-Verify secret instead of source IP"
}

resource "aws_ecs_cluster" "sandbox" {
  name = "vibesdk-sandbox"
}

resource "aws_ecs_cluster_capacity_providers" "sandbox" {
  cluster_name       = aws_ecs_cluster.sandbox.name
  capacity_providers = ["FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 100
  }
}

resource "aws_iam_role" "sandbox_task_execution" {
  name = "vibesdk-sandbox-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "sandbox_task_execution" {
  role       = aws_iam_role.sandbox_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Separate from the execution role: this is what code *inside* the
# container can do via the task's own credentials, not what ECS itself
# needs to pull the image/write logs. Scoped to the git-storage bucket
# only for now -- widen when the control plane needs more (e.g. its own
# DynamoDB state table, once designed).
resource "aws_iam_role" "sandbox_task" {
  name = "vibesdk-sandbox-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sandbox_task_git_storage" {
  name = "vibesdk-sandbox-task-git-storage"
  role = aws_iam_role.sandbox_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [local.git_storage_bucket_arn, "${local.git_storage_bucket_arn}/*"]
    }]
  })
}

resource "aws_cloudwatch_log_group" "sandbox_task" {
  name              = "/aws/ecs/vibesdk-sandbox"
  retention_in_days = 7 # Sandbox task logs are high-volume and short-lived-relevant; shorter retention than the API Lambdas' 14 days.
}

# Where aws/sandbox-container's image gets pushed -- see that package's
# README for the build/push commands. Scan-on-push is free and catches
# obviously-bad base-image CVEs before a task ever launches from it.
resource "aws_ecr_repository" "sandbox" {
  name = "vibesdk-sandbox"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# One lifecycle rule: untagged images (superseded by a new push under the
# same "latest" tag pattern) are cleaned up automatically so ECR storage
# doesn't grow unbounded -- the only real ongoing cost this repo has.
resource "aws_ecr_lifecycle_policy" "sandbox" {
  repository = aws_ecr_repository.sandbox.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 1 day"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 1
      }
      action = { type = "expire" }
    }]
  })
}

# Instance tracking for the orchestrator Lambda: instanceId -> ECS task
# ARN + public IP + status. On-demand billing, same as every other table
# in this migration -- near-zero cost at low session volume.
resource "aws_dynamodb_table" "sandbox_instances" {
  name         = "vibesdk-sandbox-instances"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "instanceId"

  attribute {
    name = "instanceId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Shared secret the orchestrator Lambda sends as X-Controlplane-Secret on
# every call to a task's control-plane port -- see main.tf's security
# group comment for why source-IP restriction alone isn't available for
# that path. One secret for the whole cluster (not per-task) keeps the
# orchestrator simple; rotating it just means a new apply + task restart.
resource "random_password" "controlplane_secret" {
  length  = 32
  special = false
}

# Placeholder image and 0.5 vCPU / 1 GB sizing per the design doc's
# cost model (down-sized from CF's 4 vCPU/8 GB spec). Real sizing needs
# the Phase 3 latency spike's actual measurements against build-heavy
# workloads before this is trusted, per that section's own caveat.
resource "aws_ecs_task_definition" "sandbox" {
  family                   = "vibesdk-sandbox"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"  # 0.5 vCPU
  memory                   = "1024" # 1 GB
  execution_role_arn       = aws_iam_role.sandbox_task_execution.arn
  task_role_arn            = aws_iam_role.sandbox_task.arn

  container_definitions = jsonencode([
    {
      name      = "sandbox"
      image     = var.sandbox_task_image
      essential = true
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }, # dev server / live preview
        { containerPort = 8080, protocol = "tcp" }, # control plane
      ]
      environment = [
        { name = "CONTROL_PORT", value = "8080" },
        { name = "DEV_PORT", value = "3000" },
        { name = "WORKSPACE_DIR", value = "/workspace/app" },
        { name = "CONTROLPLANE_SECRET", value = random_password.controlplane_secret.result },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.sandbox_task.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "sandbox"
        }
      }
    }
  ])
}
