variable "aws_region" {
  description = "AWS region for every resource in this module. Kept independent from the root stack's var.aws_region (a different root module can't share a variable definition) but should be set to the same value in practice."
  type        = string
  default     = "ap-southeast-2"
}

variable "sandbox_task_image" {
  description = "Container image URI for the sandbox task (ECR image tag or similar). No default and no real image exists yet -- ../../sandbox-contract's README explains why (the control-plane server this image needs to run hasn't been designed). Placeholder required to make the task definition syntactically valid."
  type        = string
}

variable "sandbox_alb_certificate_arn" {
  description = "ACM certificate ARN for the sandbox preview ALB's HTTPS listener (wildcard cert for the preview subdomain). No default -- provision the certificate and its DNS validation separately, outside this stack, before applying."
  type        = string
}
