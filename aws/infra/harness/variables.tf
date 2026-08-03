variable "aws_region" {
  description = "AWS region for every resource in this module. Independent from the root stack's var.aws_region (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = string
  default     = "ap-southeast-2"
}

variable "harness_task_image" {
  description = "Container image URI for the harness task. Empty default resolves to this stack's own ECR repo at the :latest tag (aws_ecr_repository.harness) -- build and push aws/agent-harness's image to that URI (see its README) either before or after the first apply; ECS only needs the image to exist by the time a real session RunTask fires, not at apply time."
  type        = string
  default     = ""
}

variable "allowed_ips" {
  description = "CIDR blocks allowed to reach harness tasks' control-plane port directly. Independent from the root stack's var.allowed_ips (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = list(string)
}

variable "anthropic_api_key" {
  description = "Passed to every harness task so the Agent SDK's query() can call the Anthropic API directly. Sensitive. Empty default lets a plain apply fall back to SSM (/vibesdk/anthropic_api_key) -- see data.aws_ssm_parameter.anthropic_api_key in main.tf."
  type        = string
  sensitive   = true
  default     = ""
}
