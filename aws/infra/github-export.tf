# API Gateway HTTP API (v2) + Lambda for aws/github-export-lambda.
# Same aws_apigatewayv2_api/integration/route/stage shape as
# user-api.tf/apps-api.tf/auth-api.tf. Needs the git storage bucket
# (s3.tf) for aws/git-storage's S3FS -- same bucket
# agent-runtime.tf's Lambda already has scoped access to, since both
# read/write the same sessions/<sessionId>/git/ key prefix.
#
# NOT deployed publicly -- see aws/github-export-lambda's README:
# this Lambda has no caller-identity/ownership check yet. Wired here
# for completeness and local validation, not as a signal that it's
# safe to put a real API Gateway route in front of a browser today.

variable "github_export_lambda_timeout_seconds" {
  description = "Longer than var.lambda_timeout_seconds's 30s default: the OAuth callback route does a token exchange, a GitHub repo-create/lookup call, and a real git push (aws/github-export-lambda/src/push.ts's own 120s push timeout) in one request."
  type        = number
  default     = 150
}

variable "github_exporter_client_id" {
  description = "GitHub OAuth App client ID for the export flow (public_repo/repo scopes) -- a different OAuth App registration from whatever the main sign-in flow uses, matching the original's GITHUB_EXPORTER_CLIENT_ID/GITHUB_EXPORTER_CLIENT_SECRET split (worker/services/oauth/github-exporter.ts)."
  type        = string
  default     = ""
}

variable "github_exporter_client_secret" {
  description = "GitHub OAuth App client secret for the export flow. See var.github_exporter_client_id."
  type        = string
  default     = ""
  sensitive   = true
}

resource "aws_iam_role" "github_export_lambda" {
  name = "vibesdk-github-export-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "github_export_lambda_basic_execution" {
  role       = aws_iam_role.github_export_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Read-only: this Lambda pushes an existing session repo, it never
# writes new git-storage objects itself (aws/agent-runtime's
# git-commit.ts owns writes) -- see aws/agent-runtime's
# agent_runtime_lambda_git_storage policy for the read/write version.
resource "aws_iam_role_policy" "github_export_lambda_git_storage" {
  name = "vibesdk-github-export-git-storage"
  role = aws_iam_role.github_export_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.git_storage.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.git_storage.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "github_export_lambda" {
  name              = "/aws/lambda/vibesdk-github-export"
  retention_in_days = 14
}

resource "aws_lambda_function" "github_export" {
  function_name = "vibesdk-github-export"
  role          = aws_iam_role.github_export_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.github_export_lambda_timeout_seconds

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../github-export-lambda/github-export-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../github-export-lambda/github-export-lambda.zip")

  environment {
    variables = {
      GIT_STORAGE_BUCKET            = aws_s3_bucket.git_storage.bucket
      JWT_SECRET                    = var.jwt_secret != "" ? var.jwt_secret : data.aws_ssm_parameter.jwt_secret.value
      GITHUB_EXPORTER_CLIENT_ID     = var.github_exporter_client_id
      GITHUB_EXPORTER_CLIENT_SECRET = var.github_exporter_client_secret
    }
  }

  depends_on = [aws_cloudwatch_log_group.github_export_lambda]
}

resource "aws_apigatewayv2_api" "github_export_http" {
  name          = "vibesdk-github-export"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "github_export_lambda" {
  api_id                 = aws_apigatewayv2_api.github_export_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.github_export.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = min(var.github_export_lambda_timeout_seconds * 1000, 30000)
}

locals {
  github_export_routes = [
    "POST /api/github/export/initiate",
    "GET /api/github/oauth/callback",
  ]
}

resource "aws_apigatewayv2_route" "github_export" {
  for_each  = toset(local.github_export_routes)
  api_id    = aws_apigatewayv2_api.github_export_http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.github_export_lambda.id}"
}

resource "aws_lambda_permission" "github_export_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.github_export.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.github_export_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "github_export_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-github-export"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "github_export" {
  api_id      = aws_apigatewayv2_api.github_export_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.github_export_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

output "github_export_api_endpoint" {
  value = aws_apigatewayv2_api.github_export_http.api_endpoint
}
