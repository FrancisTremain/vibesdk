output "sandbox_ecs_cluster_name" {
  value = aws_ecs_cluster.sandbox.name
}

output "sandbox_task_definition_arn" {
  value = aws_ecs_task_definition.sandbox.arn
}

output "sandbox_subnet_ids" {
  description = "Public subnets sandbox tasks launch into -- needed by the orchestrator Lambda's ecs:RunTask networkConfiguration."
  value       = [aws_subnet.sandbox_a.id, aws_subnet.sandbox_b.id]
}

output "sandbox_security_group_id" {
  value = aws_security_group.sandbox_task.id
}

output "sandbox_ecr_repository_url" {
  value = aws_ecr_repository.sandbox.repository_url
}

output "sandbox_instances_table_name" {
  value = aws_dynamodb_table.sandbox_instances.name
}

output "sandbox_instances_table_arn" {
  value = aws_dynamodb_table.sandbox_instances.arn
}

output "sandbox_controlplane_secret" {
  description = "Shared secret the orchestrator Lambda sends as X-Controlplane-Secret to every sandbox task. Sensitive -- consumed via terraform_remote_state by the orchestrator Lambda's own stack, not meant to be read out manually."
  value       = random_password.controlplane_secret.result
  sensitive   = true
}
