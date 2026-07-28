variable "aws_region" {
  description = "AWS region for every resource in this stack. Kept as a variable (default matches main.tf's backend, which can't itself reference a variable) rather than hardcoded per-file."
  type        = string
  default     = "ap-southeast-2"
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
# (deployment package is a local file -- see auth-api.tf -- no S3 bucket/key variables needed)

variable "public_base_url" {
  description = "Origin the auth Lambda treats as its own -- used for OAuth redirect_uri construction and validateRedirectUrl's same-origin check. E.g. https://app.vibesdk.example.com. No default: environment-specific."
  type        = string
}

variable "jwt_secret" {
  description = "JWT signing secret for aws/auth-orchestration's JWTUtils. Must be >=32 chars with at least 3 character classes (enforced at Lambda cold-start by JWTUtils' own validation) -- generate with e.g. `openssl rand -base64 48`. Defaults to empty, in which case main.tf's data.aws_ssm_parameter.jwt_secret (an SSM SecureString at /vibesdk/jwt_secret) is used instead -- never commit a real secret to Terraform state as a literal var default."
  type        = string
  sensitive   = true
  default     = ""
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
# (deployment package is a local file -- see apps-api.tf -- no S3 bucket/key variables needed)

# --- aws/user-api-lambda ---
# (deployment package is a local file -- see user-api.tf -- no S3 bucket/key variables needed)

variable "platform_model_providers" {
  description = "Optional comma-separated provider list for vibesdk-model-config-defaults' AGENT_CONFIG selection and BYOK platform-key check (matches the original's env.PLATFORM_MODEL_PROVIDERS). Empty disables it -- falls back to per-provider *_api_key variables below."
  type        = string
  default     = ""
}

variable "anthropic_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "openai_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "google_ai_studio_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "allowed_ips" {
  description = "CIDR blocks allowed to reach the site/API through CloudFront -- enforced by aws_cloudfront_function.ip_allowlist (frontend.tf), not AWS WAF, to avoid WAF's flat per-month cost. E.g. [\"203.0.113.4/32\"] for a single home/office IP. No default: an empty allowlist would block everyone, which is never what you want on apply."
  type        = list(string)
}

variable "cerebras_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "groq_api_key" {
  type      = string
  default   = ""
  sensitive = true
}
