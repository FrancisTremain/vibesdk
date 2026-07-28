# API Gateway HTTP API (v2) + Lambda for aws/user-api-lambda -- same
# shape as auth-api.tf/apps-api.tf. IAM role gets read-only on apps
# (stats reads it, never writes) and read/write on model-config (the
# provider-listing routes only read, but the role is scoped to the
# table generally since ModelProviderStore's write methods exist and
# may get wired in once upstream re-enables custom providers -- see
# that package's README). Read-only on identity/auth-flows, same
# reasoning as apps-api.tf's role.
#
# NOT APPLIED. Same status as the rest of this directory.

resource "aws_iam_role" "user_api_lambda" {
  name = "vibesdk-user-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "user_api_lambda_basic_execution" {
  role       = aws_iam_role.user_api_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "user_api_lambda_dynamodb" {
  name = "vibesdk-user-api-lambda-dynamodb"
  role = aws_iam_role.user_api_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [aws_dynamodb_table.apps.arn, "${aws_dynamodb_table.apps.arn}/index/*"]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ]
        Resource = [aws_dynamodb_table.model_config.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [aws_dynamodb_table.identity.arn, aws_dynamodb_table.auth_flows.arn]
      },
      {
        # GET /api/user/{id}/analytics, GET /api/agent/{id}/analytics.
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = [aws_dynamodb_table.llm_usage.arn, "${aws_dynamodb_table.llm_usage.arn}/index/*"]
      },
      {
        # GET /api/agent/{id}/analytics's ownership check (isSessionOwner).
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [aws_dynamodb_table.agent_sessions.arn]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "user_api_lambda" {
  name              = "/aws/lambda/vibesdk-user-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "user_api" {
  function_name = "vibesdk-user-api"
  role          = aws_iam_role.user_api_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../user-api-lambda/user-api-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../user-api-lambda/user-api-lambda.zip")

  environment {
    variables = {
      APPS_TABLE           = aws_dynamodb_table.apps.name
      MODEL_CONFIG_TABLE   = aws_dynamodb_table.model_config.name
      IDENTITY_TABLE       = aws_dynamodb_table.identity.name
      AUTH_FLOWS_TABLE     = aws_dynamodb_table.auth_flows.name
      LLM_USAGE_TABLE      = aws_dynamodb_table.llm_usage.name
      AGENT_SESSIONS_TABLE = aws_dynamodb_table.agent_sessions.name
      JWT_SECRET         = var.jwt_secret != "" ? var.jwt_secret : data.aws_ssm_parameter.jwt_secret.value
      # Read by vibesdk-model-config-defaults (AGENT_CONFIG selection,
      # BYOK-platform-key check) -- see that package's README.
      PLATFORM_MODEL_PROVIDERS = var.platform_model_providers
      ANTHROPIC_API_KEY        = var.anthropic_api_key
      OPENAI_API_KEY           = var.openai_api_key
      GOOGLE_AI_STUDIO_API_KEY = var.google_ai_studio_api_key
      CEREBRAS_API_KEY         = var.cerebras_api_key
      GROQ_API_KEY             = var.groq_api_key
      ORIGIN_VERIFY_SECRET     = random_password.origin_verify.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.user_api_lambda]
}

resource "aws_apigatewayv2_api" "user_http" {
  name          = "vibesdk-user-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "user_lambda" {
  api_id                 = aws_apigatewayv2_api.user_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.user_api.invoke_arn
  payload_format_version = "2.0"
}

# Kept in sync with aws/user-api-lambda/src/handler.ts's switch.
locals {
  user_api_routes = [
    "GET /api/user/apps",
    "PUT /api/user/profile",
    "GET /api/user/{id}/analytics",
    "GET /api/agent/{id}/analytics",
    "GET /api/stats",
    "GET /api/stats/activity",
    "GET /api/user/providers",
    "GET /api/user/providers/{id}",
    "POST /api/user/providers",
    "PUT /api/user/providers/{id}",
    "DELETE /api/user/providers/{id}",
    "GET /api/model-configs",
    "GET /api/model-configs/{agentAction}",
    "PUT /api/model-configs/{agentAction}",
    "DELETE /api/model-configs/{agentAction}",
    "POST /api/model-configs/reset-all",
  ]
}

resource "aws_apigatewayv2_route" "user_api" {
  for_each  = toset(local.user_api_routes)
  api_id    = aws_apigatewayv2_api.user_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.user_lambda.id}"
}

resource "aws_lambda_permission" "user_api_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.user_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.user_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "user_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-user-api"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "user_api" {
  api_id      = aws_apigatewayv2_api.user_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.user_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}
