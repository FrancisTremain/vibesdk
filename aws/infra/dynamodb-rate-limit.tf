# DynamoDB table for aws/rate-limit's DynamoRateLimiter -- one item per
# (rate_limit_key, bucket_start), TTL-expired automatically. See
# aws/rate-limit/README.md for why this shape (per-bucket items, not one
# growing blob per key) replaces the original DORateLimitStore.
#
# First consumer: apps-api-lambda's GET /api/apps/public (see
# apps-api.tf), matching the original's publicApps rate-limit config
# (worker/services/rate-limit/config.ts) -- 120 req/60s main window,
# 40 req/10s burst window.

resource "aws_dynamodb_table" "rate_limits" {
  name         = "vibesdk-rate-limits"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "rate_limit_key"
  range_key    = "bucket_start"

  attribute {
    name = "rate_limit_key"
    type = "S"
  }
  attribute {
    name = "bucket_start"
    type = "N"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
