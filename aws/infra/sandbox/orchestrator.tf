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

# ecs:RunTask/StopTask/DescribeTasks scoped to this cluster's task
# definition family; the two iam:PassRole grants are what let RunTask
# actually launch a task using the execution/task roles main.tf
# defines (ECS itself requires the caller to hold PassRole for both).
resource "aws_iam_role_policy" "sandbox_orchestrator_lambda_ecs" {
  name = "vibesdk-sandbox-orchestrator-lambda-ecs"
  role = aws_iam_role.sandbox_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"]
        Resource = [aws_ecs_task_definition.sandbox.arn, replace(aws_ecs_task_definition.sandbox.arn, ":${aws_ecs_task_definition.sandbox.revision}", ":*")]
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
    }
  }

  depends_on = [aws_cloudwatch_log_group.sandbox_orchestrator_lambda]
}

# Shared secret this Lambda's own caller (the not-yet-built
# code-generation orchestration layer) must send as
# X-Orchestrator-Secret -- see aws/sandbox-orchestrator-lambda's README
# for why this exists (this Lambda has no static egress IP either).
resource "random_password" "orchestrator_secret" {
  length  = 32
  special = false
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
