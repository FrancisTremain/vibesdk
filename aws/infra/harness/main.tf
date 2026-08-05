# ECS infrastructure for the generation harness: a Fargate task per
# active chat session running the Claude Agent SDK's query() loop
# (aws/agent-harness), with Bash/Write/Edit/Read disabled and replaced
# by custom tools that proxy to the sandbox task's control-plane API
# (aws/sandbox-controlplane) over its public IP -- see this migration's
# design notes on why the harness runs as its own task instead of
# inside the sandbox container: isolates the agent process (which can
# run arbitrary model-directed logic for minutes) from the disposable
# sandbox it's operating on, so a runaway agent only costs a sandbox
# restart, not a mid-session crash of the thing tracking conversation
# state and phase progress.
#
# Same Fargate Spot / no-ALB / no-NAT / public-IP-plus-shared-secret
# shape as aws/infra/sandbox -- see that module's main.tf header for
# the full cost reasoning, all of which applies identically here. A
# SEPARATE small VPC rather than reusing the sandbox module's: harness
# tasks reach the sandbox task over its public IP the same way
# aws/sandbox-orchestrator-lambda does (no VPC-internal path needed,
# so there's nothing to peer), and keeping this a fully independent
# root module avoids coupling two modules' apply lifecycles for no
# benefit -- same "SEPARATE ROOT MODULE, deliberately" reasoning as
# aws/infra/sandbox/main.tf's header.
#
# var.harness_task_image defaults to this stack's own ECR repo at
# :latest -- apply first, then build/push aws/agent-harness's image
# (see its README); ECS only needs the image to exist by the time a
# real session RunTask fires.

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

  backend "s3" {
    bucket       = "vibesdk-terraform-state"
    key          = "aws-migration/harness/terraform.tfstate"
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

# Platform Anthropic key is entirely optional -- sessions can run purely
# on a user's own uploaded Claude Code OAuth credentials (the auth.json
# branching path, see credentials-client.ts) and never touch it. The SSM
# lookup only fires when var.enable_platform_anthropic_key is set, so a
# deploy with no platform key configured anywhere never fails apply just
# because /vibesdk/anthropic_api_key hasn't been seeded (data sources
# error on a missing parameter, so this must be skipped via count rather
# than defaulted away with try()/coalesce()).
data "aws_ssm_parameter" "anthropic_api_key" {
  count           = var.anthropic_api_key == "" && var.enable_platform_anthropic_key ? 1 : 0
  name            = "/vibesdk/anthropic_api_key"
  with_decryption = true
}

locals {
  anthropic_api_key  = var.anthropic_api_key != "" ? var.anthropic_api_key : try(data.aws_ssm_parameter.anthropic_api_key[0].value, "")
  harness_task_image = var.harness_task_image != "" ? var.harness_task_image : "${aws_ecr_repository.harness.repository_url}:latest"
}

# Bridges the root stack's KMS key + identity table (aws/infra/user-credentials.tf)
# into this separate root module -- same SSM-parameter pattern this file
# already uses for the Anthropic key. Needed so the harness task's own
# role (not the orchestrator Lambda) can decrypt a user's uploaded
# credentials directly -- see aws/agent-harness/src/credentials-client.ts.
data "aws_ssm_parameter" "user_credentials_kms_key_arn" {
  name = "/vibesdk/user_credentials_kms_key_arn"
}

data "aws_ssm_parameter" "identity_table_arn" {
  name = "/vibesdk/identity_table_arn"
}

# The IAM policy below only needs the ARN, but the harness task's own
# runtime code (aws/agent-harness/src/session.ts's UserCredentialsClient)
# needs the table NAME to call DynamoDB -- this was missing entirely
# from the environment block, so every credentials lookup failed with
# "Value at 'TableName' failed to satisfy constraint: Member must have
# length greater than or equal to 1" (caught live: process.env.IDENTITY_TABLE
# defaulted to '' with no env var set at all).
data "aws_ssm_parameter" "identity_table_name" {
  name = "/vibesdk/identity_table_name"
}

# Bridges aws/infra/agent-runtime.tf's WebSocket connections table + WS
# management endpoint into this separate root module, same pattern as the
# two data sources above -- needed so aws/harness-orchestrator-lambda can
# relay a harness task's pushed events straight to the browser's open
# WebSocket connection (aws/harness-orchestrator-lambda/src/event-relay.ts),
# without routing through aws/agent-runtime's Lambda (which only runs
# reactively per inbound client message, so it has no server-push path).
data "aws_ssm_parameter" "agent_connections_table_name" {
  name = "/vibesdk/agent_connections_table_name"
}

data "aws_ssm_parameter" "agent_connections_table_arn" {
  name = "/vibesdk/agent_connections_table_arn"
}

data "aws_ssm_parameter" "agent_runtime_ws_management_endpoint" {
  name = "/vibesdk/agent_runtime_ws_management_endpoint"
}

data "aws_ssm_parameter" "agent_runtime_ws_execution_arn" {
  name = "/vibesdk/agent_runtime_ws_execution_arn"
}

# Lets receiveEvent() (aws/harness-orchestrator-lambda/src/handler.ts) forward
# real generation activity to the underlying sandbox instance via
# aws/sandbox-activity-client.ts -- bridged the same way as the
# agent_connections/ws params above, from aws/infra/sandbox/orchestrator.tf
# (also a separate root module).
data "aws_ssm_parameter" "sandbox_orchestrator_api_endpoint" {
  name = "/vibesdk/sandbox_orchestrator_api_endpoint"
}

data "aws_ssm_parameter" "sandbox_orchestrator_secret" {
  name            = "/vibesdk/sandbox_orchestrator_secret"
  with_decryption = true
}

locals {
  agent_connections_session_index = "session_id-index"
}

resource "aws_vpc" "harness" {
  cidr_block           = "10.44.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "vibesdk-harness" }
}

resource "aws_internet_gateway" "harness" {
  vpc_id = aws_vpc.harness.id
}

resource "aws_subnet" "harness_a" {
  vpc_id                  = aws_vpc.harness.id
  cidr_block              = "10.44.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
}

resource "aws_subnet" "harness_b" {
  vpc_id                  = aws_vpc.harness.id
  cidr_block              = "10.44.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true
}

resource "aws_route_table" "harness_public" {
  vpc_id = aws_vpc.harness.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.harness.id
  }
}

resource "aws_route_table_association" "harness_a" {
  subnet_id      = aws_subnet.harness_a.id
  route_table_id = aws_route_table.harness_public.id
}

resource "aws_route_table_association" "harness_b" {
  subnet_id      = aws_subnet.harness_b.id
  route_table_id = aws_route_table.harness_public.id
}

# Free gateway endpoints, same reasoning as aws/infra/sandbox/main.tf --
# the harness's own DynamoDB table traffic (session bookkeeping,
# eventually written directly by aws/harness-orchestrator-lambda, not
# the task itself, but kept here in case that changes) stays off the
# public internet path.
resource "aws_vpc_endpoint" "harness_dynamodb" {
  vpc_id            = aws_vpc.harness.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.harness_public.id]
}

resource "aws_security_group" "harness_task" {
  name        = "vibesdk-harness-task"
  description = "Harness Fargate tasks -- control plane reachable only from var.allowed_ips plus the orchestrator Lambda (no static egress IP), outbound open for the Anthropic API and the sandbox task public IP"
  vpc_id      = aws_vpc.harness.id

  ingress {
    description = "Control-plane port (aws/agent-harness HTTP server): session start, streamInput follow-ups, status polling"
    from_port   = 8081
    to_port     = 8081
    protocol    = "tcp"
    cidr_blocks = var.allowed_ips
  }

  egress {
    description = "Anthropic API calls, sandbox task control-plane calls (public IP, no VPC path), DynamoDB via gateway endpoint"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Same reasoning as aws/infra/sandbox/main.tf's
# sandbox_task_control_plane_any_source rule: the harness-orchestrator
# Lambda (aws/harness-orchestrator-lambda) has no static egress IP
# without a NAT Gateway (avoided for cost), so control-plane calls are
# authenticated by X-Controlplane-Secret instead of source IP.
resource "aws_security_group_rule" "harness_task_control_plane_any_source" {
  type              = "ingress"
  from_port         = 8081
  to_port           = 8081
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.harness_task.id
  description       = "Orchestrator Lambda has no static egress IP without a NAT Gateway (avoided for cost) -- control-plane calls are authenticated by X-Controlplane-Secret instead of source IP"
}

resource "aws_ecs_cluster" "harness" {
  name = "vibesdk-harness"
}

resource "aws_ecs_cluster_capacity_providers" "harness" {
  cluster_name       = aws_ecs_cluster.harness.name
  capacity_providers = ["FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 100
  }
}

resource "aws_iam_role" "harness_task_execution" {
  name = "vibesdk-harness-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "harness_task_execution" {
  role       = aws_iam_role.harness_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# What code *inside* the harness container can do via the task's own
# credentials. No table access needed yet -- session bookkeeping
# (status, lastActivityAt, resume ids) is written by
# aws/harness-orchestrator-lambda via the control-plane HTTP API, the
# same indirection aws/infra/sandbox uses for its instances table, so
# the task itself never touches DynamoDB directly.
resource "aws_iam_role" "harness_task" {
  name = "vibesdk-harness-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Lets a task decrypt a user's uploaded credentials directly from AWS
# APIs (always TLS) instead of the orchestrator Lambda forwarding the
# plaintext over the control plane's plain-HTTP channel -- see
# aws/agent-harness/src/credentials-client.ts and
# aws/infra/user-credentials.tf's module comment for the full reasoning.
resource "aws_iam_role_policy" "harness_task_user_credentials" {
  name = "vibesdk-harness-task-user-credentials"
  role = aws_iam_role.harness_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [data.aws_ssm_parameter.user_credentials_kms_key_arn.value]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [data.aws_ssm_parameter.identity_table_arn.value]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "harness_task" {
  name              = "/aws/ecs/vibesdk-harness"
  retention_in_days = 7 # High-volume, short-lived-relevant logs -- same retention as aws/infra/sandbox's task logs.
}

# Where aws/agent-harness's image gets pushed -- see that package's
# README for the build/push commands.
resource "aws_ecr_repository" "harness" {
  name = "vibesdk-harness"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "harness" {
  repository = aws_ecr_repository.harness.name
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

# Session tracking for the orchestrator Lambda: sessionId -> ECS task
# ARN + public IP + status + lastActivityAt (idle-timeout sweeping,
# reset on every chat message or UI-activity heartbeat -- see
# aws/harness-orchestrator-lambda's README) + the Agent SDK's own
# session id (for query({resume: ...}) after a task has been torn
# down and the user comes back). PAY_PER_REQUEST, same as every other
# table in this migration.
resource "aws_dynamodb_table" "harness_sessions" {
  name         = "vibesdk-harness-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Shared secret the orchestrator Lambda sends as X-Controlplane-Secret
# on every call to a harness task's control-plane port -- same pattern
# as aws/infra/sandbox's controlplane_secret.
resource "random_password" "harness_controlplane_secret" {
  length  = 32
  special = false
}

# 0.5 vCPU / 1 GB -- the harness itself does little heavy compute (file
# writes, command runs, and static analysis are all proxied to the
# sandbox task); this sizing may need revisiting once the Agent SDK's
# own memory footprint (it spawns the Claude Code CLI as a child
# process) is measured against a real generation session.
resource "aws_ecs_task_definition" "harness" {
  family                   = "vibesdk-harness"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"  # 0.5 vCPU
  memory                   = "1024" # 1 GB
  execution_role_arn       = aws_iam_role.harness_task_execution.arn
  task_role_arn            = aws_iam_role.harness_task.arn

  container_definitions = jsonencode([
    {
      name      = "harness"
      image     = local.harness_task_image
      essential = true
      portMappings = [
        { containerPort = 8081, protocol = "tcp" }, # control plane
      ]
      environment = concat(
        [
          { name = "CONTROL_PORT", value = "8081" },
          { name = "CONTROLPLANE_SECRET", value = random_password.harness_controlplane_secret.result },
          # Same-module resource reference, no SSM bridge needed for this
          # direction -- the harness task pushes its own real-time events
          # here (aws/agent-harness/src/session.ts's pushEvent), reusing
          # CONTROLPLANE_SECRET above to authenticate itself.
          { name = "EVENTS_ENDPOINT", value = aws_apigatewayv2_api.harness_orchestrator_http.api_endpoint },
          { name = "IDENTITY_TABLE", value = data.aws_ssm_parameter.identity_table_name.value },
        ],
        # Omitted entirely (not even an empty string) when no platform key
        # is configured, so a BYO-credentials-only deploy never ships an
        # ANTHROPIC_API_KEY env var to the container at all.
        local.anthropic_api_key != "" ? [{ name = "ANTHROPIC_API_KEY", value = local.anthropic_api_key }] : []
      )
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.harness_task.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "harness"
        }
      }
    }
  ])
}
