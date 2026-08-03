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
  description = "Optional platform-wide fallback passed to harness tasks so the Agent SDK's query() can call the Anthropic API directly for sessions that haven't uploaded their own Claude Code OAuth credentials (see the auth.json branching path in aws/agent-harness/src/session.ts). Not required -- a deploy with no platform key never fails, and BYO-credentials sessions never use it. Sensitive. Empty default falls back to SSM only if enable_platform_anthropic_key is also true -- see data.aws_ssm_parameter.anthropic_api_key in main.tf."
  type        = string
  sensitive   = true
  default     = ""
}

variable "enable_platform_anthropic_key" {
  description = "Whether to look up /vibesdk/anthropic_api_key from SSM as a platform-wide fallback for harness sessions. Leave false to run purely on user-uploaded BYO credentials with no platform key dependency at all -- terraform apply then never touches that SSM parameter and never requires it to exist."
  type        = bool
  default     = false
}
