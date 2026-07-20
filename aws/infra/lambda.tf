resource "aws_iam_role" "actor_lambda" {
  name = "vibesdk-actor-spike-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "actor_lambda_basic_execution" {
  role       = aws_iam_role.actor_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "actor_lambda_dynamodb" {
  name = "vibesdk-actor-spike-dynamodb"
  role = aws_iam_role.actor_lambda.id

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
      ]
      Resource = [
        aws_dynamodb_table.actor_state.arn,
        aws_dynamodb_table.ws_connections.arn,
        "${aws_dynamodb_table.ws_connections.arn}/index/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "actor_lambda_apigw_manage_connections" {
  name = "vibesdk-actor-spike-apigw-manage-connections"
  role = aws_iam_role.actor_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "execute-api:ManageConnections"
      Resource = "${aws_apigatewayv2_api.actor_ws.execution_arn}/*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "actor_lambda" {
  name              = "/aws/lambda/vibesdk-actor-spike"
  retention_in_days = 7
}

resource "aws_lambda_function" "actor" {
  function_name = "vibesdk-actor-spike"
  role          = aws_iam_role.actor_lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  # Direct local-file deployment -- see auth-api.tf's comment for why.
  filename         = "${path.module}/../actor-spike/actor-spike.zip"
  source_code_hash = filebase64sha256("${path.module}/../actor-spike/actor-spike.zip")

  environment {
    variables = {
      ACTOR_STATE_TABLE    = aws_dynamodb_table.actor_state.name
      WS_CONNECTIONS_TABLE = aws_dynamodb_table.ws_connections.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.actor_lambda]
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.actor.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.actor_ws.execution_arn}/*/*"
}
