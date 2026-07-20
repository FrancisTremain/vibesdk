# WebSocket API replacing the earlier "pin a session to a worker task"
# design: connectionId -> sessionId routing lives in DynamoDB
# (ws_connections table), not in any long-lived compute.

resource "aws_apigatewayv2_api" "actor_ws" {
  name                       = "vibesdk-actor-spike-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "actor_lambda" {
  api_id                    = aws_apigatewayv2_api.actor_ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.actor.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.actor_ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.actor_lambda.id}"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.actor_ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.actor_lambda.id}"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.actor_ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.actor_lambda.id}"
}

resource "aws_cloudwatch_log_group" "actor_ws_access_logs" {
  name              = "/aws/apigateway/vibesdk-actor-spike-ws"
  retention_in_days = 7
}

resource "aws_apigatewayv2_stage" "spike" {
  api_id      = aws_apigatewayv2_api.actor_ws.id
  name        = "spike"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.actor_ws_access_logs.arn
    format = jsonencode({
      requestId       = "$context.requestId"
      connectionId    = "$context.connectionId"
      eventType       = "$context.eventType"
      routeKey        = "$context.routeKey"
      status          = "$context.status"
      integrationLatency = "$context.integrationLatency"
    })
  }
}
