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

output "identity_table_name" {
  value = aws_dynamodb_table.identity.name
}

output "apps_table_name" {
  value = aws_dynamodb_table.apps.name
}

output "auth_flows_table_name" {
  value = aws_dynamodb_table.auth_flows.name
}

output "model_config_table_name" {
  value = aws_dynamodb_table.model_config.name
}

output "audit_log_table_name" {
  value = aws_dynamodb_table.audit_log.name
}

output "system_settings_table_name" {
  value = aws_dynamodb_table.system_settings.name
}

output "git_storage_bucket_name" {
  value = aws_s3_bucket.git_storage.bucket
}

output "git_storage_bucket_arn" {
  description = "Consumed by aws/infra/sandbox's separate root module via terraform_remote_state, for the sandbox task role's S3 policy."
  value       = aws_s3_bucket.git_storage.arn
}

output "auth_api_endpoint" {
  description = "https:// base URL for the auth API (invoke_url already includes the $default stage)."
  value       = aws_apigatewayv2_stage.auth_api.invoke_url
}

output "apps_api_endpoint" {
  description = "https:// base URL for the apps API (invoke_url already includes the $default stage)."
  value       = aws_apigatewayv2_stage.apps_api.invoke_url
}

output "user_api_endpoint" {
  description = "https:// base URL for the user (stats/providers) API (invoke_url already includes the $default stage)."
  value       = aws_apigatewayv2_stage.user_api.invoke_url
}
