# KMS-backed storage for the harness's per-user auth branching path:
# a user can upload their own Claude Code OAuth credentials (colloquially
# "auth.json" -- really `.credentials.json`'s `claudeAiOauth` blob, see
# aws/agent-harness/src/credentials-client.ts) instead of using the
# platform's workspace-scoped Anthropic API key. Stored as one more item
# under the existing `vibesdk-identity` table (vibesdk-db-identity's
# HarnessCredentialsStore) rather than a new table.
#
# Direct KMS Encrypt/Decrypt (not envelope encryption) is deliberate --
# a `.credentials.json` blob is well under KMS's 4KB Encrypt/Decrypt
# plaintext limit, so the extra complexity of a data-key envelope buys
# nothing here.
#
# Encryption happens in aws/user-api-lambda at upload time (kms:Encrypt,
# see aws_iam_role_policy.user_api_lambda_kms below). Decryption happens
# inside the harness Fargate task itself at session-start time
# (kms:Decrypt via its own task role, granted in aws/infra/harness/main.tf)
# -- the orchestrator Lambda and the control-plane's plain-HTTP channel
# never see the plaintext credential, only a userId reference.

resource "aws_kms_key" "user_credentials" {
  description             = "Encrypts user-uploaded Claude Code OAuth credentials for the generation harness's BYO-auth branching path"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "user_credentials" {
  name          = "alias/vibesdk-user-credentials"
  target_key_id = aws_kms_key.user_credentials.key_id
}

resource "aws_iam_role_policy" "user_api_lambda_kms" {
  name = "vibesdk-user-api-lambda-kms"
  role = aws_iam_role.user_api_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # PUT /api/user/credentials encrypts the uploaded blob before
        # storing it; DELETE never needs Decrypt (it just removes the
        # DynamoDB item) and GET only reports authMode, never the
        # ciphertext -- so Encrypt is the only KMS action this role needs.
        # The corresponding DynamoDB PutItem/DeleteItem grant lives in
        # user-api.tf's aws_iam_role_policy.user_api_lambda_dynamodb,
        # alongside this role's other DynamoDB statements.
        Effect   = "Allow"
        Action   = ["kms:Encrypt"]
        Resource = [aws_kms_key.user_credentials.arn]
      },
    ]
  })
}

# Bridges this stack's KMS key + identity table to aws/infra/harness's
# separate root module (own state, can't share a resource reference
# directly) -- same SSM-parameter pattern as
# harness_orchestrator_endpoint/secret and sandbox_controlplane_secret.
resource "aws_ssm_parameter" "user_credentials_kms_key_arn" {
  name  = "/vibesdk/user_credentials_kms_key_arn"
  type  = "String"
  value = aws_kms_key.user_credentials.arn
}

resource "aws_ssm_parameter" "identity_table_arn" {
  name  = "/vibesdk/identity_table_arn"
  type  = "String"
  value = aws_dynamodb_table.identity.arn
}

resource "aws_ssm_parameter" "identity_table_name" {
  name  = "/vibesdk/identity_table_name"
  type  = "String"
  value = aws_dynamodb_table.identity.name
}
