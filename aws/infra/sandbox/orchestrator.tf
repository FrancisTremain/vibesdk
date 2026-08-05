# API Gateway HTTP API (v2) + Lambda for aws/sandbox-orchestrator-lambda.
# Same aws_apigatewayv2_api/integration/route/stage shape as the root
# stack's user-api.tf/apps-api.tf/auth-api.tf, but this one lives in
# the sandbox module (not the root stack) since every resource it
# needs -- the ECS cluster/task definition, the security group, the
# instances table, the controlplane secret -- is already local to this
# module. Its own HTTP API rather than a route added to the root
# stack's API Gateway: that would require this module to hand its
# Lambda's invoke ARN back to the root stack, inverting the
# terraform_remote_state direction (root -> sandbox) used everywhere
# else in this migration.
#
# Not attached to the sandbox VPC -- see aws/sandbox-orchestrator-lambda's
# README for why (ENI cold-start latency, and it has no need for one:
# every AWS call it makes is a regional API call, not a VPC-internal one).
#
# NOT APPLIED. Same status as the rest of this directory.

variable "lambda_memory_mb" {
  description = "Independent from the root stack's var.lambda_memory_mb -- a different root module can't share a variable definition."
  type        = number
  default     = 1024
}

variable "orchestrator_lambda_timeout_seconds" {
  description = "Longer than the root stack's default 30s (var.lambda_timeout_seconds): createInstance blocks on ECS RunTask -> DescribeTasks polling (up to 90s) plus the sandbox's own bootstrap (dependency install + dev-server start), not just a DynamoDB round trip."
  type        = number
  default     = 180
}

resource "aws_iam_role" "sandbox_orchestrator_lambda" {
  name = "vibesdk-sandbox-orchestrator-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "sandbox_orchestrator_lambda_basic_execution" {
  role       = aws_iam_role.sandbox_orchestrator_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sandbox_orchestrator_lambda_dynamodb" {
  name = "vibesdk-sandbox-orchestrator-lambda-dynamodb"
  role = aws_iam_role.sandbox_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.sandbox_instances.arn]
    }]
  })
}

# ecs:RunTask's resource is the task *definition* family; ecs:StopTask and
# ecs:DescribeTasks instead operate on running task *instances*, a
# different ARN shape (arn:...:task/<cluster>/<task-id>) -- lumping all
# three under the task-definition ARN silently leaves StopTask/DescribeTasks
# unauthorized (caught live: DescribeTasks failing with AccessDenied for
# the sandbox orchestrator during a real generation run). The two
# iam:PassRole grants are what let RunTask actually launch a task using
# the execution/task roles main.tf defines (ECS itself requires the
# caller to hold PassRole for both).
resource "aws_iam_role_policy" "sandbox_orchestrator_lambda_ecs" {
  name = "vibesdk-sandbox-orchestrator-lambda-ecs"
  role = aws_iam_role.sandbox_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = [aws_ecs_task_definition.sandbox.arn, replace(aws_ecs_task_definition.sandbox.arn, ":${aws_ecs_task_definition.sandbox.revision}", ":*")]
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.sandbox.arn }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:StopTask", "ecs:DescribeTasks"]
        Resource = "${replace(aws_ecs_cluster.sandbox.arn, "cluster/", "task/")}/*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.sandbox.arn }
        }
      },
      {
        # ListTasks (sandbox-orchestrator-lambda/src/reaper.ts's sweep)
        # authorizes against a container-instance/* resource pattern, not
        # the cluster ARN itself or a task/* pattern like StopTask/
        # DescribeTasks above -- confirmed live (AccessDeniedException
        # naming exactly this ARN shape) even though Fargate tasks have no
        # real EC2 container instances behind them; ECS's IAM model still
        # evaluates ListTasks this way regardless of launch type.
        Effect   = "Allow"
        Action   = "ecs:ListTasks"
        Resource = "${replace(aws_ecs_cluster.sandbox.arn, "cluster/", "container-instance/")}/*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.sandbox.arn }
        }
      },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.sandbox_task_execution.arn, aws_iam_role.sandbox_task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = "ec2:DescribeNetworkInterfaces"
        Resource = "*" # DescribeNetworkInterfaces does not support resource-level restriction.
      },
    ]
  })
}

# alb-manager.ts's target-group/rule lifecycle (one pair created per
# session, torn down on shutdown -- see alb.tf's header comment for why
# this exists at all). CreateTargetGroup/DescribeRules/DescribeTargetGroups
# don't support resource-level restriction (the target group ARN doesn't
# exist yet when CreateTargetGroup is called, and Describe* need to see
# every target group/rule to find a free listener-rule priority); the
# rest are scoped to this stack's own listener and the "sbx-" target-group
# name prefix alb-manager.ts always uses.
resource "aws_iam_role_policy" "sandbox_orchestrator_lambda_elb" {
  name = "vibesdk-sandbox-orchestrator-lambda-elb"
  role = aws_iam_role.sandbox_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetGroups"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets", "elasticloadbalancing:DescribeTargetHealth"]
        Resource = "arn:aws:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:targetgroup/sbx-*/*"
      },
      {
        Effect = "Allow"
        Action = ["elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule"]
        Resource = [
          aws_lb_listener.sandbox_preview_https.arn,
          "arn:aws:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:listener-rule/app/${aws_lb.sandbox_preview.name}/*",
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "sandbox_orchestrator_lambda" {
  name              = "/aws/lambda/vibesdk-sandbox-orchestrator"
  retention_in_days = 14
}

resource "aws_lambda_function" "sandbox_orchestrator" {
  function_name = "vibesdk-sandbox-orchestrator"
  role          = aws_iam_role.sandbox_orchestrator_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.orchestrator_lambda_timeout_seconds

  # Direct local-file deployment -- see the root stack's auth-api.tf
  # comment for why (no S3 deployment bucket in this cost-minimal setup).
  filename         = "${path.module}/../../sandbox-orchestrator-lambda/sandbox-orchestrator-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../sandbox-orchestrator-lambda/sandbox-orchestrator-lambda.zip")

  environment {
    variables = {
      SANDBOX_INSTANCES_TABLE = aws_dynamodb_table.sandbox_instances.name
      ECS_CLUSTER             = aws_ecs_cluster.sandbox.name
      ECS_TASK_DEFINITION_ARN = aws_ecs_task_definition.sandbox.arn
      ECS_SUBNET_IDS          = "${aws_subnet.sandbox_a.id},${aws_subnet.sandbox_b.id}"
      ECS_SECURITY_GROUP_ID   = aws_security_group.sandbox_task.id
      ECS_CONTAINER_NAME      = "sandbox"
      CONTROLPLANE_SECRET     = random_password.controlplane_secret.result
      ORCHESTRATOR_SECRET     = random_password.orchestrator_secret.result
      ALB_LISTENER_ARN        = aws_lb_listener.sandbox_preview_https.arn
      SANDBOX_VPC_ID          = aws_vpc.sandbox.id
      PREVIEW_DOMAIN          = var.preview_domain
    }
  }

  depends_on = [aws_cloudwatch_log_group.sandbox_orchestrator_lambda]
}

# Scheduled safety net against orphaned sandbox ECS tasks -- see
# sandbox-orchestrator-lambda/src/reaper.ts's header comment for why this
# exists as a second, independent line of defense beyond createInstance's
# own stopTask-on-failure cleanup (a live incident during this migration
# found 18 tasks running with zero DynamoDB tracking records, silently
# accruing cost for days -- the table's own TTL deletes the tracking row,
# not the actual ECS task). Reuses the orchestrator's IAM role/zip rather
# than standing up a parallel package: same account, same cluster, and the
# permissions it needs (ecs:ListTasks/StopTask, dynamodb Scan/DeleteItem,
# elb DeleteRule/DeleteTargetGroup) are already granted to that role.
resource "aws_cloudwatch_log_group" "sandbox_reaper_lambda" {
  name              = "/aws/lambda/vibesdk-sandbox-reaper"
  retention_in_days = 14
}

resource "aws_lambda_function" "sandbox_reaper" {
  function_name = "vibesdk-sandbox-reaper"
  role          = aws_iam_role.sandbox_orchestrator_lambda.arn
  handler       = "reaper.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  # Just ListTasks + a handful of StopTask/DeleteItem/deregister calls per
  # run, not a cold-start-and-bootstrap sandbox -- nowhere near
  # orchestrator_lambda_timeout_seconds's 180s.
  timeout = 60

  filename         = "${path.module}/../../sandbox-orchestrator-lambda/sandbox-orchestrator-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../sandbox-orchestrator-lambda/sandbox-orchestrator-lambda.zip")

  environment {
    variables = {
      SANDBOX_INSTANCES_TABLE = aws_dynamodb_table.sandbox_instances.name
      ECS_CLUSTER             = aws_ecs_cluster.sandbox.name
      ALB_LISTENER_ARN        = aws_lb_listener.sandbox_preview_https.arn
      SANDBOX_VPC_ID          = aws_vpc.sandbox.id
      PREVIEW_DOMAIN          = var.preview_domain
      # Matches reaper.ts's own default -- set explicitly rather than left
      # implicit so this value is the one place both the schedule interval
      # below and the actual idle threshold need to be kept sane relative
      # to each other (checking every 5 min against a 15 min threshold
      # gives a worst-case detection lag of ~5 min past the real cutoff,
      # not a full extra sweep interval).
      IDLE_TIMEOUT_SECONDS = "900"
    }
  }

  depends_on = [aws_cloudwatch_log_group.sandbox_reaper_lambda]
}

resource "aws_cloudwatch_event_rule" "sandbox_reaper_schedule" {
  name                = "vibesdk-sandbox-reaper-schedule"
  description         = "Periodic sweep for orphaned/expired/idle sandbox ECS tasks -- see aws_lambda_function.sandbox_reaper's comment. 5 minutes so a 15-minute idle threshold is enforced with reasonable precision, not just eventually."
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "sandbox_reaper" {
  rule = aws_cloudwatch_event_rule.sandbox_reaper_schedule.name
  arn  = aws_lambda_function.sandbox_reaper.arn
}

resource "aws_lambda_permission" "sandbox_reaper_eventbridge_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sandbox_reaper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sandbox_reaper_schedule.arn
}

# Shared secret this Lambda's own caller (the not-yet-built
# code-generation orchestration layer) must send as
# X-Orchestrator-Secret -- see aws/sandbox-orchestrator-lambda's README
# for why this exists (this Lambda has no static egress IP either).
resource "random_password" "orchestrator_secret" {
  length  = 32
  special = false
}

# Bridges this endpoint/secret into aws/infra/harness (a separate root
# module, so it can't reference this module's resources directly) -- same
# cross-module SSM pattern as aws/infra/agent-runtime.tf's
# agent_connections_table_name/agent_runtime_ws_management_endpoint
# bridge into that same harness module. Lets
# aws/harness-orchestrator-lambda/src/sandbox-activity-client.ts forward
# real generation activity as this instance's own activity signal
# (reaper.ts's idle-sweep) without the caller resupplying it.
resource "aws_ssm_parameter" "sandbox_orchestrator_api_endpoint" {
  name  = "/vibesdk/sandbox_orchestrator_api_endpoint"
  type  = "String"
  value = aws_apigatewayv2_api.sandbox_orchestrator_http.api_endpoint
}

resource "aws_ssm_parameter" "sandbox_orchestrator_secret_bridge" {
  name  = "/vibesdk/sandbox_orchestrator_secret"
  type  = "SecureString"
  value = random_password.orchestrator_secret.result
}

resource "aws_apigatewayv2_api" "sandbox_orchestrator_http" {
  name          = "vibesdk-sandbox-orchestrator"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "sandbox_orchestrator_lambda" {
  api_id                 = aws_apigatewayv2_api.sandbox_orchestrator_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.sandbox_orchestrator.invoke_arn
  payload_format_version = "2.0"
  # API Gateway v2 integration timeout is capped at 30000ms regardless of
  # the Lambda's own configured timeout (180s here) -- min() keeps this
  # correct even if orchestrator_lambda_timeout_seconds changes.
  timeout_milliseconds = min(var.orchestrator_lambda_timeout_seconds * 1000, 30000)
}

# Kept in sync with aws/sandbox-orchestrator-lambda/src/handler.ts's switch.
locals {
  sandbox_orchestrator_routes = [
    "POST /api/sandbox/instances",
    "GET /api/sandbox/instances",
    "GET /api/sandbox/instances/{id}",
    "GET /api/sandbox/instances/{id}/status",
    "DELETE /api/sandbox/instances/{id}",
    "POST /api/sandbox/instances/{id}/activity",
    "POST /api/sandbox/instances/{id}/files",
    "GET /api/sandbox/instances/{id}/files",
    "POST /api/sandbox/instances/{id}/commands",
    "GET /api/sandbox/instances/{id}/logs",
    "GET /api/sandbox/instances/{id}/errors",
    "POST /api/sandbox/instances/{id}/errors/clear",
    "POST /api/sandbox/instances/{id}/analysis",
    "POST /api/sandbox/instances/{id}/deploy",
  ]
}

resource "aws_apigatewayv2_route" "sandbox_orchestrator" {
  for_each  = toset(local.sandbox_orchestrator_routes)
  api_id    = aws_apigatewayv2_api.sandbox_orchestrator_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.sandbox_orchestrator_lambda.id}"
}

resource "aws_lambda_permission" "sandbox_orchestrator_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sandbox_orchestrator.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.sandbox_orchestrator_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "sandbox_orchestrator_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-sandbox-orchestrator"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "sandbox_orchestrator" {
  api_id      = aws_apigatewayv2_api.sandbox_orchestrator_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.sandbox_orchestrator_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

# Not put behind CloudFront/WAF like the main site's APIs -- this
# endpoint isn't browser-facing (only the not-yet-built code-generation
# orchestration layer calls it, server to server) and is protected by
# the X-Orchestrator-Secret header instead. If that caller ever needs
# to reach this from a fixed, allowlist-able network, revisit.
output "sandbox_orchestrator_api_endpoint" {
  value = aws_apigatewayv2_api.sandbox_orchestrator_http.api_endpoint
}

output "sandbox_orchestrator_secret" {
  description = "Value the caller must send as X-Orchestrator-Secret. Sensitive -- consumed by whatever service ends up calling this Lambda."
  value       = random_password.orchestrator_secret.result
  sensitive   = true
}
