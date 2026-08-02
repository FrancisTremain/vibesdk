variable "aws_region" {
  description = "AWS region for every resource in this module. Independent from the root stack's var.aws_region (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = string
  default     = "ap-southeast-2"
}

variable "harness_task_image" {
  description = "Container image URI for the harness task, e.g. <account-id>.dkr.ecr.<region>.amazonaws.com/vibesdk-harness:latest (the repo this stack provisions, aws_ecr_repository.harness). No default -- build and push aws/agent-harness's image first, then set this to the pushed URI."
  type        = string
}

variable "allowed_ips" {
  description = "CIDR blocks allowed to reach harness tasks' control-plane port directly. Independent from the root stack's var.allowed_ips (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = list(string)
}

variable "anthropic_api_key" {
  description = "Passed to every harness task so the Agent SDK's query() can call the Anthropic API directly. Sensitive."
  type        = string
  sensitive   = true
}
