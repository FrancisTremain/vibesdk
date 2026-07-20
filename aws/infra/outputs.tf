output "websocket_endpoint" {
  description = "wss:// URL to connect the spike client to (stage-specific, not a custom domain — this is a spike, not production routing)."
  value       = aws_apigatewayv2_stage.spike.invoke_url
}

output "actor_state_table_name" {
  value = aws_dynamodb_table.actor_state.name
}

output "ws_connections_table_name" {
  value = aws_dynamodb_table.ws_connections.name
}
