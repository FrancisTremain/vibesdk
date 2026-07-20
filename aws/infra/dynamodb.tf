# Two tables for the actor-model spike, matching the design doc's
# decisions: no standing worker to pin a session to, so a session's
# state lives entirely in DynamoDB between Lambda invocations, and
# connection routing is the standard API Gateway WebSocket pattern.

resource "aws_dynamodb_table" "actor_state" {
  name         = "vibesdk-actor-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  # Optimistic per-session lock (design doc: "per-session mutation lock
  # via a DynamoDB conditional write"). Every write conditions on
  # lock_version matching what the writer read, so two concurrent
  # invocations for the same session can't both apply a mutation.
  # lock_version itself is a plain attribute, not part of the key.

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "ws_connections" {
  name         = "vibesdk-ws-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  attribute {
    name = "session_id"
    type = "S"
  }

  # Needed to push a message to every connection currently attached to a
  # session (a session can have more than one open tab/reconnect race).
  global_secondary_index {
    name            = "by-session"
    hash_key        = "session_id"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
