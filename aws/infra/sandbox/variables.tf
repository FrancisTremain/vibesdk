variable "aws_region" {
  description = "AWS region for every resource in this module. Kept independent from the root stack's var.aws_region (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = string
  default     = "ap-southeast-2"
}

variable "sandbox_task_image" {
  description = "Container image URI for the sandbox task, e.g. <account-id>.dkr.ecr.<region>.amazonaws.com/vibesdk-sandbox:latest (the repo this stack provisions, aws_ecr_repository.sandbox). No default -- build and push aws/sandbox-container's image first (see that package's README), then set this to the pushed URI."
  type        = string
}

variable "allowed_ips" {
  description = "CIDR blocks allowed to reach sandbox tasks' dev-server (live preview) and control-plane ports directly. Independent from the root stack's var.allowed_ips (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = list(string)
}
