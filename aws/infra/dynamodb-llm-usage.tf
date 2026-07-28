# DynamoDB table backing vibesdk-db-llm-usage -- written by
# aws/agent-runtime after each aws/llm-client `runInference` call, read
# by aws/user-api-lambda's GET /api/user/{id}/analytics and
# GET /api/agent/{id}/analytics. AWS-native replacement for the
# original's Cloudflare AI Gateway GraphQL analytics query -- see that
# package's module comment.

resource "aws_dynamodb_table" "llm_usage" {
  name         = "vibesdk-llm-usage"
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
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
