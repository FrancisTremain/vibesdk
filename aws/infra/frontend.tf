# Static frontend hosting for the Vite/React app (the existing /src client,
# built standalone via `vite build` -- it calls same-origin /api/* so no
# frontend code changes are needed as long as this distribution fronts both
# the S3-hosted static assets and the three API Gateway backends on the same
# domain/paths.
#
# Deployed at the domain apex (var.public_base_url's host) rather than a
# /vibesdk sub-path: the domain was otherwise completely empty (no existing
# DNS records), and mounting a Vite SPA under a sub-path requires rewriting
# its root-relative asset URLs (a CloudFront Function or base-path build
# flag) for no real benefit here since nothing else lives on this domain.
#
# CloudFront needs its ACM certificate in us-east-1 regardless of which
# region the distribution's origins live in (ap-southeast-2 here) -- hence
# the aliased provider below.

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project = "vibesdk"
    }
  }
}

locals {
  site_domain = replace(replace(var.public_base_url, "https://", ""), "/", "")
}

# Shared secret CloudFront injects into every request it forwards to the
# three API origins (see the `custom_header` block on each `origin` below).
# Each Lambda handler rejects any request missing/mismatching this header,
# so the only way in is through CloudFront -- which is what the IP
# allowlist (aws_cloudfront_function.ip_allowlist, below) actually
# protects. Without this, the allowlist would only cover
# https://<domain>/api/*; the raw execute-api.*.amazonaws.com URLs would
# stay directly reachable by anyone, bypassing it entirely (API Gateway
# HTTP API v2 has no WAF/resource-policy support of its own).
resource "random_password" "origin_verify" {
  length  = 32
  special = false
}

resource "aws_s3_bucket" "frontend" {
  bucket = "vibesdk-frontend-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "vibesdk-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid       = "AllowCloudFrontOAC"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}

resource "aws_acm_certificate" "site" {
  provider          = aws.us_east_1
  domain_name       = local.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

output "cert_validation_records" {
  description = "Add these as DNS CNAME records (DNS-only, not proxied) in Cloudflare to validate the ACM certificate."
  value = {
    for dvo in aws_acm_certificate.site.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

# Not using aws_acm_certificate_validation here since the DNS zone is on
# Cloudflare, not Route53 -- validation records are added manually (see
# cert_validation_records output) and this resource would otherwise block
# apply indefinitely waiting for a validation Terraform can't complete
# itself.

resource "aws_cloudfront_origin_request_policy" "api_passthrough" {
  name = "vibesdk-api-passthrough"

  cookies_config {
    cookie_behavior = "all"
  }
  headers_config {
    header_behavior = "allViewer"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

# IP pinhole at the edge. AWS WAF (aws_wafv2_web_acl) would do this too,
# but WAF bills a flat ~$5/mo per Web ACL plus ~$1/mo per rule regardless
# of traffic -- real money for a personal project with near-zero volume.
# A CloudFront Function has no base fee (~$0.10 per *million*
# invocations) and runs at the same point in the request path (before
# origin fetch, before cache), so it blocks non-allowlisted IPs just as
# effectively for this traffic profile.
resource "aws_cloudfront_function" "ip_allowlist" {
  name    = "vibesdk-ip-allowlist"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Blocks everything except var.allowed_ips -- the network-level pinhole. ALLOWED_EMAIL in aws/auth-api-lambda is an application-level lock on top of this, not instead of it."
  code = templatefile("${path.module}/cloudfront-functions/ip-allowlist.js.tftpl", {
    allowed_ips_json = jsonencode(var.allowed_ips)
  })
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [local.site_domain]

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.auth_http.api_endpoint, "https://", "")
    origin_id   = "auth-api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.apps_http.api_endpoint, "https://", "")
    origin_id   = "apps-api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.user_http.api_endpoint, "https://", "")
    origin_id   = "user-api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS managed CachingOptimized

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/auth/*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "auth-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # AWS managed CachingDisabled
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_passthrough.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/apps/*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "apps-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_passthrough.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/stats*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "user-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_passthrough.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/user/*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "user-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_passthrough.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/model-configs*"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "user-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_passthrough.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.site.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

output "cloudfront_domain_name" {
  description = "Add a DNS-only (not proxied) CNAME/ALIAS record for the apex domain pointing here in Cloudflare."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  value = "https://${local.site_domain}"
}
