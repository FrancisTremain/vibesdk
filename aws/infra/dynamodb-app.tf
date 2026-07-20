# The six application tables from docs/aws-dynamodb-schema.md, backing
# the aws/db-*, aws/auth-*, and aws/oauth-clients packages ported so
# far. Every attribute/GSI/TTL config below is checked directly against
# what the shipped store code in this repo actually writes -- not
# transcribed from the schema doc's paper design, which drifted from
# the real code in a few places as those packages got built (see each
# package's README for specifics). Where the schema doc describes a
# GSI or attribute no shipped code writes yet (the identity table's
# `by-provider` GSI, notably), it's omitted here rather than
# provisioned speculatively; add it when a real caller needs it.
#
# NOT APPLIED. Same status as dynamodb.tf (the actor-spike tables) --
# written without a local `terraform` binary to validate/fmt, needs
# both plus human review before any apply.

# Table 1: vibesdk-identity (aws/db-identity)
# Users, OAuth identities, sessions, API keys. No GSI: every access
# pattern shipped so far is either a direct pk+sk fetch or a dedicated
# lookup item (EMAIL#, USERNAME#, OAUTHLOOKUP#, SESSIONID#, APIKEYID#,
# APIKEYHASH#), all sharing this table's base key schema.
resource "aws_dynamodb_table" "identity" {
  name         = "vibesdk-identity"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # Session items and their SESSIONID# lookup items carry this --
  # matches the session's own expiresAt, replacing a manual cleanup
  # sweep. Not present on User/API-key/lookup items, which don't expire.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Table 2: vibesdk-apps (aws/db-apps)
# Apps plus favorites/stars/views. gsi1 = "this user's apps"
# (gsi1pk=userId, gsi1sk=updatedAt), gsi2 = the public listing gallery
# (gsi2pk is a constant partition value written by the app store,
# gsi2sk=updatedAt) -- a deliberate single-hot-partition tradeoff for
# MVP list sizes, documented in the schema doc.
resource "aws_dynamodb_table" "apps" {
  name         = "vibesdk-apps"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "N"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "N"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  # View-dedup markers (APP#<id> / VIEW#<viewerHash>) only -- TTL'd to
  # the end of the current dedup bucket, doubling as the dedup window's
  # own cleanup.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Table 3: vibesdk-auth-flows (aws/db-auth-flows)
# OAuth CSRF state, auth-attempt log, password reset / email
# verification tokens, OTPs. No GSI -- every access pattern is a direct
# key lookup or a bounded partition query (auth attempts, OTPs).
resource "aws_dynamodb_table" "auth_flows" {
  name         = "vibesdk-auth-flows"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # Every item type in this table is transient by nature and carries a
  # TTL -- OAuth state and tokens expire with the flow, auth attempts
  # get a fixed 24h window regardless of outcome.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Table 4: vibesdk-model-config (aws/db-model-config)
# Per-user LLM provider/model configuration. No GSI, no TTL -- config
# doesn't expire, and every access pattern is "give me this user's
# config," a single Query on USER#<userId> with an SK prefix.
resource "aws_dynamodb_table" "model_config" {
  name         = "vibesdk-model-config"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
}

# Table 5: vibesdk-audit-log (aws/db-audit)
# Append-only security/audit trail. gsi1 = "this user's recent events"
# (gsi1pk=userId, gsi1sk=createdAt) -- only written when an entry has a
# userId (some audit entries, per the original D1 schema's
# onDelete:'set null', legitimately don't).
resource "aws_dynamodb_table" "audit_log" {
  name         = "vibesdk-audit-log"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "N"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
}

# Table 6: vibesdk-system-settings (aws/db-audit)
# Tiny global config, PK-only (SETTING#<key>), no SK, no GSI, no TTL.
resource "aws_dynamodb_table" "system_settings" {
  name         = "vibesdk-system-settings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}
