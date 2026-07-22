# WebSocket API + Lambda + DynamoDB for aws/agent-runtime -- the real
# actor-model session runtime, built on the same connectionId ->
# sessionId routing / optimistic-lock pattern aws/actor-spike proved
# out (apigateway.tf/lambda.tf/dynamodb.tf). Deliberately separate
# resources from the spike's: that stays the throwaway latency-
# measurement artifact it was built as (see its own README), not
# repurposed into the real thing.
#
# NOT APPLIED. Same status as the rest of this directory.

variable "agent_runtime_lambda_timeout_seconds" {
  description = "Longer than var.lambda_timeout_seconds's 30s default: user_suggestion's mutate step calls out to an LLM provider (aws/llm-client), including its own retry-with-backoff on 429/5xx, which can comfortably exceed 30s on a slow or rate-limited response."
  type        = number
  default     = 60
}

variable "agent_model_id" {
  description = "aws/model-config-defaults's provider/model-name id (e.g. anthropic/claude-sonnet-4-5) used for aws/agent-runtime's user_suggestion single-turn completion. Independent of the real per-agent-action AGENT_CONFIG selection worker/agents/inferutils/config.ts does -- this runtime doesn't have that config wired in yet, see aws/agent-runtime's README."
  type        = string
  default     = "anthropic/claude-sonnet-4-5"
}

resource "aws_dynamodb_table" "agent_sessions" {
  name         = "vibesdk-agent-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "agent_connections" {
  name         = "vibesdk-agent-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

resource "aws_apigatewayv2_api" "agent_ws" {
  name                       = "vibesdk-agent-runtime-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "agent_runtime_lambda" {
  api_id                    = aws_apigatewayv2_api.agent_ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.agent_runtime.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "agent_connect" {
  api_id    = aws_apigatewayv2_api.agent_ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.agent_runtime_lambda.id}"
}

resource "aws_apigatewayv2_route" "agent_disconnect" {
  api_id    = aws_apigatewayv2_api.agent_ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.agent_runtime_lambda.id}"
}

resource "aws_apigatewayv2_route" "agent_default" {
  api_id    = aws_apigatewayv2_api.agent_ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.agent_runtime_lambda.id}"
}

resource "aws_cloudwatch_log_group" "agent_ws_access_logs" {
  name              = "/aws/apigateway/vibesdk-agent-runtime-ws"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "agent_runtime" {
  api_id      = aws_apigatewayv2_api.agent_ws.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.agent_ws_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      connectionId       = "$context.connectionId"
      eventType          = "$context.eventType"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

resource "aws_iam_role" "agent_runtime_lambda" {
  name = "vibesdk-agent-runtime-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "agent_runtime_lambda_basic_execution" {
  role       = aws_iam_role.agent_runtime_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "agent_runtime_lambda_dynamodb" {
  name = "vibesdk-agent-runtime-dynamodb"
  role = aws_iam_role.agent_runtime_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      Resource = [aws_dynamodb_table.agent_sessions.arn, aws_dynamodb_table.agent_connections.arn]
    }]
  })
}

resource "aws_iam_role_policy" "agent_runtime_lambda_apigw_manage_connections" {
  name = "vibesdk-agent-runtime-apigw-manage-connections"
  role = aws_iam_role.agent_runtime_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "execute-api:ManageConnections"
      Resource = "${aws_apigatewayv2_api.agent_ws.execution_arn}/*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "agent_runtime_lambda" {
  name              = "/aws/lambda/vibesdk-agent-runtime"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_runtime" {
  function_name = "vibesdk-agent-runtime"
  role          = aws_iam_role.agent_runtime_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.agent_runtime_lambda_timeout_seconds

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../agent-runtime/agent-runtime.zip"
  source_code_hash = filebase64sha256("${path.module}/../agent-runtime/agent-runtime.zip")

  environment {
    variables = {
      AGENT_SESSIONS_TABLE    = aws_dynamodb_table.agent_sessions.name
      AGENT_CONNECTIONS_TABLE = aws_dynamodb_table.agent_connections.name
      # aws/llm-client provider dispatch -- see that package's README for
      # the provider/model-name id convention and the apiKeyEnvVarFor()
      # naming this must match (${PROVIDER}_API_KEY, matching
      # aws/model-config-defaults's byok-helper.ts convention).
      AGENT_MODEL_ID           = var.agent_model_id
      ANTHROPIC_API_KEY        = var.anthropic_api_key
      OPENAI_API_KEY           = var.openai_api_key
      GOOGLE_AI_STUDIO_API_KEY = var.google_ai_studio_api_key
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_runtime_lambda]
}

resource "aws_lambda_permission" "agent_runtime_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_runtime.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.agent_ws.execution_arn}/*/*"
}

output "agent_runtime_ws_endpoint" {
  value = aws_apigatewayv2_stage.agent_runtime.invoke_url
}
