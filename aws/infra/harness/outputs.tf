output "harness_ecs_cluster_name" {
  value = aws_ecs_cluster.harness.name
}

output "harness_task_definition_arn" {
  value = aws_ecs_task_definition.harness.arn
}

output "harness_subnet_ids" {
  description = "Public subnets harness tasks launch into -- needed by the orchestrator Lambda's ecs:RunTask networkConfiguration."
  value       = [aws_subnet.harness_a.id, aws_subnet.harness_b.id]
}

output "harness_security_group_id" {
  value = aws_security_group.harness_task.id
}

output "harness_ecr_repository_url" {
  value = aws_ecr_repository.harness.repository_url
}

output "harness_sessions_table_name" {
  value = aws_dynamodb_table.harness_sessions.name
}

output "harness_sessions_table_arn" {
  value = aws_dynamodb_table.harness_sessions.arn
}

output "harness_controlplane_secret" {
  description = "Shared secret the orchestrator Lambda sends as X-Controlplane-Secret to every harness task. Sensitive -- consumed via terraform_remote_state by the orchestrator Lambda's own resources in this module."
  value       = random_password.harness_controlplane_secret.result
  sensitive   = true
}
