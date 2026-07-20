# ECS infrastructure shape for on-demand sandbox tasks, per
# docs/aws-migration-technical-design.md's "Sandbox + deploy port"
# (Phase 5) decisions: Fargate Spot, launched fresh per session via
# ecs:RunTask, no standing pool -- replacing CF's UserAppSandboxService
# (@cloudflare/sandbox against the `cloudflare/sandbox` container
# image, see ../../../SandboxDockerfile).
#
# INFRASTRUCTURE SHAPE ONLY. This provisions the hosting shell a
# control-plane implementation would run on -- it does not include any
# actual sandbox control-plane server, because none exists yet (see
# ../../sandbox-contract's README for why that's a real design task, not
# a port). The task definition below references a placeholder image;
# nothing here can serve real sandbox traffic until that control plane
# is designed and built.
#
# A SEPARATE ROOT MODULE from the rest of aws/infra, deliberately --
# see this directory's own README for why: in short, this stack's two
# variables with no possible default (sandbox_task_image,
# sandbox_alb_certificate_arn) would otherwise block terraform plan/apply
# on the entire aws/infra stack, including the parts that ARE ready to
# deploy today (the DynamoDB tables, S3 bucket, and the auth/apps/user
# Lambda APIs). Split out so "first deployable cut" doesn't require
# placeholder values for infrastructure nothing can use yet.
#
# NOT APPLIED. Same status as the rest of this directory.
#
# One deliberate deviation from the design doc's literal cost-model
# line ("small Spot task replacing a NAT Gateway" for sandbox egress):
# a Fargate task's ENI is ephemeral and changes every task restart, so
# it can't be a stable VPC route-table target the way a NAT Gateway or
# NAT instance can -- there's no clean way to point private-subnet
# routes at a "NAT task" that gets replaced on every launch. Simpler
# and actually cheaper: run sandbox tasks directly in **public**
# subnets with `assign_public_ip = true`, security-group-restricted to
# only accept inbound from the ALB. Zero standing NAT cost (no NAT
# Gateway's ~$32/mo floor, no hand-rolled NAT task to operate), which
# fits this migration's hard <$100/mo budget better than either
# alternative -- consistent with the zero-idle-cost philosophy used
# everywhere else in this design (Lambda-first, DynamoDB on-demand).
# The tradeoff is a public IP per running sandbox task, mitigated by
# the security group only permitting inbound from the ALB.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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

resource "aws_security_group" "sandbox_alb" {
  name        = "vibesdk-sandbox-alb"
  description = "Sandbox preview ALB -- public HTTPS in, forwards to sandbox tasks only"
  vpc_id      = aws_vpc.sandbox.id

  ingress {
    description = "HTTPS from anywhere (preview URLs)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "sandbox_task" {
  name        = "vibesdk-sandbox-task"
  description = "Sandbox Fargate tasks -- inbound only from the ALB, outbound open for package installs"
  vpc_id      = aws_vpc.sandbox.id

  ingress {
    description     = "Dev server port, ALB only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.sandbox_alb.id]
  }

  egress {
    description = "Package installs, LLM calls if a sandbox ever needs one, S3/DynamoDB via gateway endpoint"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "sandbox" {
  name               = "vibesdk-sandbox"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.sandbox_alb.id]
  subnets            = [aws_subnet.sandbox_a.id, aws_subnet.sandbox_b.id]
}

# Placeholder default target group -- per-session routing (mapping a
# session's preview URL to the specific ECS task launched for it) is
# runtime behavior the provisioning/routing Lambda would perform via
# elbv2:RegisterTargets at RunTask launch time, and elbv2:DeregisterTargets
# on shutdown/idle-eviction. That Lambda doesn't exist yet -- it depends
# on the same not-yet-designed control plane aws/sandbox-contract's
# README describes. This target group and a catch-all listener rule
# exist so the ALB itself has a valid default action; nothing routes
# through the default in real use.
resource "aws_lb_target_group" "sandbox_default" {
  name        = "vibesdk-sandbox-default"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.sandbox.id
  target_type = "ip" # Fargate awsvpc mode -- targets are task ENIs, not instances.

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_listener" "sandbox_https" {
  load_balancer_arn = aws_lb.sandbox.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.sandbox_alb_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.sandbox_default.arn
  }
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
        { containerPort = 3000, protocol = "tcp" }
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
