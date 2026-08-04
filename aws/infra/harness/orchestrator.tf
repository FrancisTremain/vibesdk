# API Gateway HTTP API (v2) + Lambda for aws/harness-orchestrator-lambda.
# Same shape as aws/infra/sandbox/orchestrator.tf -- see that file's
# header for why this lives in the harness module rather than the root
# stack (every resource it needs is already local here).
#
# Not attached to the harness VPC -- same reasoning as
# aws/infra/sandbox/orchestrator.tf: every AWS call this Lambda makes
# is a regional API call (ecs:RunTask/DescribeTasks/StopTask,
# DynamoDB), not a VPC-internal one, and it reaches a harness task's
# control-plane port over that task's public IP the same way it
# reaches a sandbox task's.
#
# Also owns the idle-timeout sweep: an EventBridge rule invokes this
# same Lambda once a minute with a synthetic "sweep" event
# (aws/harness-orchestrator-lambda/src/handler.ts special-cases it).
# The sweep scans vibesdk-harness-sessions for RUNNING sessions whose
# lastActivityAt is older than var.idle_timeout_seconds, stops their
# task, and marks the session IDLE (task torn down, DynamoDB record
# and Agent SDK resume id kept) -- see aws/agent-harness/README for
# the resume flow this enables.
#
# NOT APPLIED. Same status as the rest of this directory.

variable "lambda_memory_mb" {
  description = "Independent from the root stack's var.lambda_memory_mb -- a different root module can't share a variable definition."
  type        = number
  default     = 1024
}

variable "orchestrator_lambda_timeout_seconds" {
  description = "Longer than the root stack's default 30s: session creation blocks on ECS RunTask -> DescribeTasks polling (up to 90s) plus the harness's own Agent SDK query() startup."
  type        = number
  default     = 180
}

# Sliding idle timeout: a session's task is stopped after this long
# with no chat message and no UI-activity heartbeat. Reset on either
# signal -- see aws/agent-runtime's websocket handler for what counts
# as activity (chat messages, and editor/preview interaction in the
# side-by-side view). 10 minutes: long enough to survive a coffee
# break without a cold start, short enough that idle tasks don't
# accumulate real cost across concurrent sessions.
variable "idle_timeout_seconds" {
  type    = number
  default = 600
}

resource "aws_iam_role" "harness_orchestrator_lambda" {
  name = "vibesdk-harness-orchestrator-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "harness_orchestrator_lambda_basic_execution" {
  role       = aws_iam_role.harness_orchestrator_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "harness_orchestrator_lambda_dynamodb" {
  name = "vibesdk-harness-orchestrator-lambda-dynamodb"
  role = aws_iam_role.harness_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.harness_sessions.arn]
    }]
  })
}

resource "aws_iam_role_policy" "harness_orchestrator_lambda_event_relay" {
  name = "vibesdk-harness-orchestrator-lambda-event-relay"
  role = aws_iam_role.harness_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Looks up which WebSocket connection(s) are open for a given
        # session id, via the session_id-index GSI -- see
        # aws/harness-orchestrator-lambda/src/event-relay.ts.
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [data.aws_ssm_parameter.agent_connections_table_arn.value, "${data.aws_ssm_parameter.agent_connections_table_arn.value}/index/*"]
      },
      {
        # PostToConnection on aws/infra/agent-runtime.tf's WebSocket API.
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = ["${data.aws_ssm_parameter.agent_runtime_ws_execution_arn.value}/*/POST/@connections/*"]
      },
    ]
  })
}

resource "aws_iam_role_policy" "harness_orchestrator_lambda_ecs" {
  name = "vibesdk-harness-orchestrator-lambda-ecs"
  role = aws_iam_role.harness_orchestrator_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"]
        Resource = [aws_ecs_task_definition.harness.arn, replace(aws_ecs_task_definition.harness.arn, ":${aws_ecs_task_definition.harness.revision}", ":*")]
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.harness.arn }
        }
      },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.harness_task_execution.arn, aws_iam_role.harness_task.arn]
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

resource "aws_cloudwatch_log_group" "harness_orchestrator_lambda" {
  name              = "/aws/lambda/vibesdk-harness-orchestrator"
  retention_in_days = 14
}

resource "aws_lambda_function" "harness_orchestrator" {
  function_name = "vibesdk-harness-orchestrator"
  role          = aws_iam_role.harness_orchestrator_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.orchestrator_lambda_timeout_seconds

  # Direct local-file deployment -- see the root stack's auth-api.tf
  # comment for why (no S3 deployment bucket in this cost-minimal setup).
  filename         = "${path.module}/../../harness-orchestrator-lambda/harness-orchestrator-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../harness-orchestrator-lambda/harness-orchestrator-lambda.zip")

  environment {
    variables = {
      HARNESS_SESSIONS_TABLE  = aws_dynamodb_table.harness_sessions.name
      ECS_CLUSTER             = aws_ecs_cluster.harness.name
      ECS_TASK_DEFINITION_ARN = aws_ecs_task_definition.harness.arn
      ECS_SUBNET_IDS          = "${aws_subnet.harness_a.id},${aws_subnet.harness_b.id}"
      ECS_SECURITY_GROUP_ID   = aws_security_group.harness_task.id
      ECS_CONTAINER_NAME      = "harness"
      CONTROLPLANE_SECRET     = random_password.harness_controlplane_secret.result
      ORCHESTRATOR_SECRET     = random_password.harness_orchestrator_secret.result
      IDLE_TIMEOUT_SECONDS    = tostring(var.idle_timeout_seconds)

      # Real-time event relay (aws/harness-orchestrator-lambda/src/event-relay.ts)
      # -- see main.tf's SSM data sources for where these values come from.
      AGENT_CONNECTIONS_TABLE         = data.aws_ssm_parameter.agent_connections_table_name.value
      AGENT_CONNECTIONS_SESSION_INDEX = local.agent_connections_session_index
      WS_MANAGEMENT_ENDPOINT          = data.aws_ssm_parameter.agent_runtime_ws_management_endpoint.value
    }
  }

  depends_on = [aws_cloudwatch_log_group.harness_orchestrator_lambda]
}

# Shared secret this Lambda's own caller (aws/agent-runtime) must send
# as X-Orchestrator-Secret -- same pattern as
# aws/infra/sandbox/orchestrator.tf's orchestrator_secret.
resource "random_password" "harness_orchestrator_secret" {
  length  = 32
  special = false
}

resource "aws_apigatewayv2_api" "harness_orchestrator_http" {
  name          = "vibesdk-harness-orchestrator"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "harness_orchestrator_lambda" {
  api_id                 = aws_apigatewayv2_api.harness_orchestrator_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.harness_orchestrator.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = min(var.orchestrator_lambda_timeout_seconds * 1000, 30000)
}

# Kept in sync with aws/harness-orchestrator-lambda/src/handler.ts's switch.
locals {
  harness_orchestrator_routes = [
    "POST /api/harness/sessions",
    "GET /api/harness/sessions/{id}/status",
    "POST /api/harness/sessions/{id}/messages",
    "POST /api/harness/sessions/{id}/activity",
    "DELETE /api/harness/sessions/{id}",
    # Inbound: a harness task pushes its own real-time HarnessEvents here
    # (aws/agent-harness/src/session.ts's pushEvent), authenticated with
    # CONTROLPLANE_SECRET rather than every other route's ORCHESTRATOR_SECRET
    # -- see handler.ts's verifyHarnessCaller.
    "POST /api/harness/sessions/{id}/events",
  ]
}

resource "aws_apigatewayv2_route" "harness_orchestrator" {
  for_each  = toset(local.harness_orchestrator_routes)
  api_id    = aws_apigatewayv2_api.harness_orchestrator_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.harness_orchestrator_lambda.id}"
}

resource "aws_lambda_permission" "harness_orchestrator_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.harness_orchestrator.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.harness_orchestrator_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "harness_orchestrator_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-harness-orchestrator"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "harness_orchestrator" {
  api_id      = aws_apigatewayv2_api.harness_orchestrator_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.harness_orchestrator_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

# Drives the idle-timeout sweep: invokes the same Lambda directly
# (bypassing API Gateway) once a minute with a synthetic detail-type
# the handler recognizes. A 1-minute cadence keeps the worst-case
# overshoot past the 10-minute idle threshold small without scanning
# the sessions table excessively -- the table is expected to stay
# small (one item per concurrently-active or recently-active session).
resource "aws_cloudwatch_event_rule" "harness_idle_sweep" {
  name                = "vibesdk-harness-idle-sweep"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "harness_idle_sweep" {
  rule  = aws_cloudwatch_event_rule.harness_idle_sweep.name
  arn   = aws_lambda_function.harness_orchestrator.arn
  input = jsonencode({ "detail-type" = "vibesdk.harness.idle_sweep" })
}

resource "aws_lambda_permission" "harness_idle_sweep_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.harness_orchestrator.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.harness_idle_sweep.arn
}

# Not put behind CloudFront/WAF -- server-to-server only (agent-runtime
# calls it), protected by X-Orchestrator-Secret instead. Same reasoning
# as aws/infra/sandbox/orchestrator.tf's equivalent output.
output "harness_orchestrator_api_endpoint" {
  value = aws_apigatewayv2_api.harness_orchestrator_http.api_endpoint
}

output "harness_orchestrator_secret" {
  description = "Value the caller (aws/agent-runtime) must send as X-Orchestrator-Secret. Sensitive."
  value       = random_password.harness_orchestrator_secret.result
  sensitive   = true
}
