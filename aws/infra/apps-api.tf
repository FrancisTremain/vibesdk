# API Gateway HTTP API (v2) + Lambda for aws/apps-api-lambda -- same
# shape as auth-api.tf. This Lambda's IAM role gets read/write on the
# apps table but read-only on identity (it only calls
# AuthOrchestrator.validateTokenAndGetUser, never registers/logs in/
# revokes anything), unlike the auth Lambda's role.
#
# NOT APPLIED. Same status as the rest of this directory.

resource "aws_iam_role" "apps_api_lambda" {
  name = "vibesdk-apps-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apps_api_lambda_basic_execution" {
  role       = aws_iam_role.apps_api_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "apps_api_lambda_dynamodb" {
  name = "vibesdk-apps-api-lambda-dynamodb"
  role = aws_iam_role.apps_api_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
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
        Resource = [
          aws_dynamodb_table.apps.arn,
          "${aws_dynamodb_table.apps.arn}/index/*",
        ]
      },
      {
        # Rate-limit bucket increments (GET /api/apps/public).
        Effect = "Allow"
        Action = [
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [aws_dynamodb_table.rate_limits.arn]
      },
      {
        # Token validation only -- read the user/session, never write.
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.identity.arn,
          aws_dynamodb_table.auth_flows.arn,
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "apps_api_lambda" {
  name              = "/aws/lambda/vibesdk-apps-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "apps_api" {
  function_name = "vibesdk-apps-api"
  role          = aws_iam_role.apps_api_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../apps-api-lambda/apps-api-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../apps-api-lambda/apps-api-lambda.zip")

  environment {
    variables = {
      APPS_TABLE           = aws_dynamodb_table.apps.name
      IDENTITY_TABLE       = aws_dynamodb_table.identity.name
      AUTH_FLOWS_TABLE     = aws_dynamodb_table.auth_flows.name
      RATE_LIMITS_TABLE    = aws_dynamodb_table.rate_limits.name
      JWT_SECRET           = var.jwt_secret
      ORIGIN_VERIFY_SECRET = random_password.origin_verify.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.apps_api_lambda]
}

resource "aws_apigatewayv2_api" "apps_http" {
  name          = "vibesdk-apps-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "apps_lambda" {
  api_id                 = aws_apigatewayv2_api.apps_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.apps_api.invoke_arn
  payload_format_version = "2.0"
}

# Kept in sync with aws/apps-api-lambda/src/handler.ts's switch.
locals {
  apps_api_routes = [
    "GET /api/status",
    "GET /api/capabilities",
    "GET /api/apps/public",
    "GET /api/apps",
    "GET /api/apps/recent",
    "GET /api/apps/{id}",
    "POST /api/apps/{id}/star",
    "POST /api/apps/{id}/favorite",
    "PUT /api/apps/{id}/visibility",
    "DELETE /api/apps/{id}",
  ]
}

resource "aws_apigatewayv2_route" "apps_api" {
  for_each  = toset(local.apps_api_routes)
  api_id    = aws_apigatewayv2_api.apps_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.apps_lambda.id}"
}

resource "aws_lambda_permission" "apps_api_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.apps_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.apps_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "apps_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-apps-api"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "apps_api" {
  api_id      = aws_apigatewayv2_api.apps_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apps_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}
