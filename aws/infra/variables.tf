variable "lambda_package_s3_bucket" {
  description = "S3 bucket holding the built actor-spike Lambda deployment package (from vibesdk's aws/actor-spike/, built and uploaded by CI — not built by this Terraform). No default: must be supplied by the caller once a build pipeline exists."
  type        = string
}

variable "lambda_package_s3_key" {
  description = "S3 key for the built actor-spike Lambda deployment package."
  type        = string
}

variable "lambda_memory_mb" {
  description = "Default per docs/aws-migration-design.md's 'Defaults chosen to unblock building' section — tune from real Phase 3 latency measurements, not a guess."
  type        = number
  default     = 1024
}

variable "lambda_timeout_seconds" {
  description = "Default per docs/aws-migration-design.md's 'Defaults chosen to unblock building' section."
  type        = number
  default     = 30
}
