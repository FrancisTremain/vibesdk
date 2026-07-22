# API Gateway HTTP API (v2) + Lambda for aws/browser-capture-lambda.
# Same shape as github-export.tf/user-api.tf. Lives in the same root
# stack as agent-runtime.tf (unlike aws/infra/sandbox, a separate
# module) so its endpoint/secret can be wired directly by resource
# reference below -- no plain-variable/remote-state indirection needed
# here, since there's no cross-stack apply-order problem to avoid.
#
# NOT APPLIED, and would fail to actually serve a screenshot even if
# applied -- see aws/browser-capture-lambda's README: the Chromium
# binary comes from a Lambda Layer this repo doesn't build. Wired here
# for completeness and local validation only.

variable "chromium_lambda_layer_arn" {
  description = "ARN of a Lambda Layer providing @sparticuz/chromium and playwright-core under /opt/nodejs/node_modules/ (see aws/browser-capture-lambda's README for why this isn't bundled into the function's own zip). No default -- build and publish that layer first."
  type        = string
  default     = ""
}

variable "browser_capture_lambda_timeout_seconds" {
  description = "Longer than var.lambda_timeout_seconds's 30s default: cold-starting Chromium plus a real page navigation (up to capture.ts's own 30s navigation timeout) plus screenshot upload can exceed 30s, especially on a cold Lambda execution environment."
  type        = number
  default     = 60
}

resource "aws_s3_bucket" "screenshots" {
  bucket = "vibesdk-screenshots-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "screenshots" {
  bucket                  = aws_s3_bucket.screenshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "screenshots" {
  bucket = aws_s3_bucket.screenshots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Screenshots are ephemeral debug artifacts consumed via a 1h presigned
# URL (aws/browser-capture-lambda/src/screenshot-storage.ts) right
# after capture, not durable state -- unlike git_storage's bucket
# (s3.tf), this one doesn't need to keep anything around.
resource "aws_s3_bucket_lifecycle_configuration" "screenshots" {
  bucket = aws_s3_bucket.screenshots.id
  rule {
    id     = "expire-after-7-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
  }
}

resource "random_password" "browser_capture_secret" {
  length  = 32
  special = false
}

resource "aws_iam_role" "browser_capture_lambda" {
  name = "vibesdk-browser-capture-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "browser_capture_lambda_basic_execution" {
  role       = aws_iam_role.browser_capture_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "browser_capture_lambda_s3" {
  name = "vibesdk-browser-capture-s3"
  role = aws_iam_role.browser_capture_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "${aws_s3_bucket.screenshots.arn}/*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "browser_capture_lambda" {
  name              = "/aws/lambda/vibesdk-browser-capture"
  retention_in_days = 7 # High-volume, short-lived-relevant, same reasoning as the sandbox task log group.
}

resource "aws_lambda_function" "browser_capture" {
  function_name = "vibesdk-browser-capture"
  role          = aws_iam_role.browser_capture_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  # Chromium needs headroom beyond var.lambda_memory_mb's 1024 MB
  # default -- a dedicated size instead of the shared variable.
  memory_size = 1536
  timeout     = var.browser_capture_lambda_timeout_seconds
  layers      = var.chromium_lambda_layer_arn != "" ? [var.chromium_lambda_layer_arn] : []

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../browser-capture-lambda/browser-capture-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../browser-capture-lambda/browser-capture-lambda.zip")

  environment {
    variables = {
      SCREENSHOTS_BUCKET     = aws_s3_bucket.screenshots.bucket
      BROWSER_CAPTURE_SECRET = random_password.browser_capture_secret.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.browser_capture_lambda]
}

resource "aws_apigatewayv2_api" "browser_capture_http" {
  name          = "vibesdk-browser-capture"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "browser_capture_lambda" {
  api_id                 = aws_apigatewayv2_api.browser_capture_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.browser_capture.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = min(var.browser_capture_lambda_timeout_seconds * 1000, 30000)
}

resource "aws_apigatewayv2_route" "browser_capture" {
  api_id    = aws_apigatewayv2_api.browser_capture_http.id
  route_key = "POST /api/browser/capture"
  target    = "integrations/${aws_apigatewayv2_integration.browser_capture_lambda.id}"
}

resource "aws_lambda_permission" "browser_capture_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.browser_capture.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.browser_capture_http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "browser_capture_http_access_logs" {
  name              = "/aws/apigateway/vibesdk-browser-capture"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "browser_capture" {
  api_id      = aws_apigatewayv2_api.browser_capture_http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.browser_capture_http_access_logs.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}
