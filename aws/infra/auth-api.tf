# API Gateway HTTP API (v2) + Lambda for aws/auth-api-lambda -- the
# auth slice of Phase 4's "port the Worker entrypoint to API Gateway +
# Lambda". HTTP API, not REST API: cheaper, and this handler doesn't
# need REST API's extra features (request validators, usage plans,
# etc.) -- API Gateway HTTP API's Lambda proxy integration is the same
# shape used for every other stateless-request Lambda in this design.
#
# NOT APPLIED. Same status as the rest of this directory -- written
# without a local `terraform` binary to validate/fmt, needs both plus
# human review (especially `jwt_secret` sourcing -- see that
# variable's description) before any apply.

resource "aws_iam_role" "auth_api_lambda" {
  name = "vibesdk-auth-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "auth_api_lambda_basic_execution" {
  role       = aws_iam_role.auth_api_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Scoped to exactly the three tables aws/auth-orchestration touches
# (identity, auth-flows, audit-log) -- not apps/model-config/etc.,
# which this Lambda never reads or writes.
resource "aws_iam_role_policy" "auth_api_lambda_dynamodb" {
  name = "vibesdk-auth-api-lambda-dynamodb"
  role = aws_iam_role.auth_api_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
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
        aws_dynamodb_table.identity.arn,
        aws_dynamodb_table.auth_flows.arn,
        aws_dynamodb_table.audit_log.arn,
        "${aws_dynamodb_table.audit_log.arn}/index/*",
      ]
    }]
  })
}

resource "aws_cloudwatch_log_group" "auth_api_lambda" {
  name              = "/aws/lambda/vibesdk-auth-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "auth_api" {
  function_name = "vibesdk-auth-api"
  role          = aws_iam_role.auth_api_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  # Direct local-file deployment, not S3 -- the built zip is ~110KB,
  # comfortably under Lambda's 50MB direct-upload limit, so there's no
  # need for an upload-to-S3-first step for a package this small.
  # source_code_hash drives redeploy-on-change (Terraform diffs it,
  # not the file's mtime).
  filename         = "${path.module}/../auth-api-lambda/auth-api-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../auth-api-lambda/auth-api-lambda.zip")

  environment {
    variables = {
      PUBLIC_BASE_URL      = var.public_base_url
      IDENTITY_TABLE       = aws_dynamodb_table.identity.name
      AUTH_FLOWS_TABLE     = aws_dynamodb_table.auth_flows.name
      AUDIT_TABLE          = aws_dynamodb_table.audit_log.name
      JWT_SECRET           = var.jwt_secret != "" ? var.jwt_secret : data.aws_ssm_parameter.jwt_secret.value
      ALLOWED_EMAIL        = var.allowed_email
      GITHUB_CLIENT_ID     = var.github_oauth_client_id
      GITHUB_CLIENT_SECRET = var.github_oauth_client_secret
      GOOGLE_CLIENT_ID     = var.google_oauth_client_id
      GOOGLE_CLIENT_SECRET = var.google_oauth_client_secret
      ORIGIN_VERIFY_SECRET = random_password.origin_verify.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.auth_api_lambda]
}

resource "aws_apigatewayv2_api" "auth_http" {
  name          = "vibesdk-auth-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "auth_lambda" {
  api_id                 = aws_apigatewayv2_api.auth_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.auth_api.invoke_arn
  payload_format_version = "2.0"
}

# One route per (method, path) the handler's routeKey switch actually
# matches -- explicit routes rather than a single "ANY /{proxy+}"
# catch-all, so an unmatched request 404s at API Gateway rather than
# being forwarded to the Lambda's own default case. Keep this list in
# sync with aws/auth-api-lambda/src/handler.ts's switch statement.
locals {
  auth_api_routes = [
    "POST /api/auth/register",
    "POST /api/auth/login",
    "POST /api/auth/logout",
    "GET /api/auth/check",
    "GET /api/auth/profile",
    "PUT /api/auth/profile",
    "POST /api/auth/verify-email",
    "POST /api/auth/resend-verification",
    "GET /api/auth/oauth/{provider}",
    "GET /api/auth/link/{provider}",
    "GET /api/auth/callback/{provider}",
    "GET /api/auth/identities",
    "DELETE /api/auth/identities/{provider}",
    "GET /api/auth/sessions",
    "DELETE /api/auth/sessions/{sessionId}",
    "GET /api/auth/api-keys",
    "POST /api/auth/api-keys",
    "DELETE /api/auth/api-keys/{keyId}",
    "POST /api/auth/exchange-api-key",
  ]
}

resource "aws_apigatewayv2_route" "auth_api" {
  for_each  = toset(local.auth_api_routes)
  api_id    = aws_apigatewayv2_api.auth_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.auth_lambda.id}"
}

resource "aws_lambda_permission" "auth_api_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.auth_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "auth_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-auth-api"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "auth_api" {
  api_id      = aws_apigatewayv2_api.auth_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.auth_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}
