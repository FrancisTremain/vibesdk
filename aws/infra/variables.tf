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

# --- aws/auth-api-lambda ---

variable "auth_api_lambda_package_s3_bucket" {
  description = "S3 bucket holding the built aws/auth-api-lambda deployment package. No default: no build pipeline exists yet."
  type        = string
}

variable "auth_api_lambda_package_s3_key" {
  description = "S3 key for the built aws/auth-api-lambda deployment package."
  type        = string
}

variable "public_base_url" {
  description = "Origin the auth Lambda treats as its own -- used for OAuth redirect_uri construction and validateRedirectUrl's same-origin check. E.g. https://app.vibesdk.example.com. No default: environment-specific."
  type        = string
}

variable "jwt_secret" {
  description = "JWT signing secret for aws/auth-orchestration's JWTUtils. Must be >=32 chars with at least 3 character classes (enforced at Lambda cold-start by JWTUtils' own validation) -- generate with e.g. `openssl rand -base64 48`. No default: never commit a real secret to Terraform state as a literal; source this from SSM Parameter Store / Secrets Manager in the real apply, not this variable directly, once a secrets pipeline exists."
  type        = string
  sensitive   = true
}

variable "allowed_email" {
  description = "Optional deployment-wide email allowlist (AuthOrchestrator's enforceAllowedEmail gate). Empty string disables the gate."
  type        = string
  default     = ""
}

variable "github_oauth_client_id" {
  description = "Optional -- omit (with the secret) to disable GitHub login."
  type        = string
  default     = ""
}

variable "github_oauth_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "google_oauth_client_id" {
  description = "Optional -- omit (with the secret) to disable Google login."
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

# --- aws/apps-api-lambda ---

variable "apps_api_lambda_package_s3_bucket" {
  description = "S3 bucket holding the built aws/apps-api-lambda deployment package. No default: no build pipeline exists yet."
  type        = string
}

variable "apps_api_lambda_package_s3_key" {
  description = "S3 key for the built aws/apps-api-lambda deployment package."
  type        = string
}
