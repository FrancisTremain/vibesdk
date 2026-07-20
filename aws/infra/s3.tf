# Git storage bucket for aws/git-storage's S3FS -- one bucket, every
# session's git data under its own `sessions/<sessionId>/git/` key
# prefix (see that package's README for the full key scheme). No
# per-session bucket: S3 has no meaningful per-bucket cost or limit
# that would motivate splitting, and prefix-scoping already gives
# every access pattern S3FS needs (HeadObject/GetObject/PutObject/
# DeleteObject/ListObjectsV2 with Delimiter, all scoped by key prefix).
#
# NOT APPLIED. Same status as the rest of this directory -- written
# without a local `terraform` binary to validate/fmt, needs both plus
# human review before any apply.

resource "aws_s3_bucket" "git_storage" {
  bucket = "vibesdk-git-storage-${data.aws_caller_identity.current.account_id}"
}

# Versioning off deliberately: S3FS treats each key as the current
# state of one chunk/dirmeta, not an append-only log -- old versions
# would just accumulate storage cost with no code path that ever reads
# them back.
resource "aws_s3_bucket_versioning" "git_storage" {
  bucket = aws_s3_bucket.git_storage.id
  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_public_access_block" "git_storage" {
  bucket                  = aws_s3_bucket.git_storage.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "git_storage" {
  bucket = aws_s3_bucket.git_storage.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
