# TLS termination in front of sandbox preview traffic. Added after the
# original "no ALB" decision (main.tf's header comment) turned out to be
# incompatible with the in-app preview panel: browsers unconditionally
# block an HTTPS page (the CloudFront-served frontend) from fetching/
# embedding plain-HTTP content, so `http://<task-public-ip>:3000` could
# never load inside the app no matter how long the dev server had been up
# (confirmed live -- every attempt failed instantly with "TypeError:
# Failed to fetch", not a readiness/timing issue). This is the same role
# Cloudflare's worker/index.ts proxyToSandbox played in the original
# architecture.
#
# One ALB, permanently -- not blue/green. It's stateless routing
# infrastructure (which hostname maps to which sandbox task), not a
# versioned application deployment target; its "state" is entirely
# runtime data the orchestrator Lambda manages via target groups and
# host-header listener rules on every session launch/teardown (see
# aws/sandbox-orchestrator-lambda/src/alb-manager.ts). The $16-20/mo
# fixed cost this module's original comment flagged is a real tradeoff,
# accepted here because there's no cheaper way to get a browser-trusted
# TLS handshake per ephemeral session without either standing up
# equivalent per-session infra elsewhere or accepting the mixed-content
# block permanently.
#
# The control-plane port (8080) is deliberately NOT routed through this
# ALB -- that's harness-to-sandbox server-to-server traffic
# (aws/agent-runtime/src/harness-generation.ts's deriveControlUrl),
# unaffected by mixed-content blocking since no browser is involved, and
# switching it to a hostname this ALB doesn't listen on for would just
# break it. Only the dev-server port (3000, browser-facing live preview)
# needs this.

data "aws_caller_identity" "current" {}

# No default: which domain sandbox previews live under is
# environment-specific, same reasoning as var.allowed_ips having none.
# Wildcard cert + wildcard DNS CNAME are both for "*.${var.preview_domain}",
# e.g. preview_domain = "preview.tremain.dev" covers
# "<sessionId>.preview.tremain.dev".
variable "preview_domain" {
  description = "Parent domain for sandbox preview hostnames -- each session gets '<instanceId>.<preview_domain>'. A wildcard ACM cert and a single wildcard DNS CNAME (added once, manually, in Cloudflare -- see output preview_cert_validation_records) cover every session; no per-session DNS work needed."
  type        = string
}

# DNS-validated like frontend.tf's site cert, and for the identical
# reason: the zone is on Cloudflare, not Route53, so
# aws_acm_certificate_validation would block apply forever waiting on a
# validation Terraform has no way to complete itself. Regional (not
# us-east-1) -- unlike CloudFront, ALB certificates must live in the same
# region as the load balancer.
resource "aws_acm_certificate" "preview" {
  domain_name       = "*.${var.preview_domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

output "preview_cert_validation_records" {
  description = "Add this as a DNS CNAME record (DNS-only, not proxied) in Cloudflare to validate the wildcard preview certificate -- one-time setup, same pattern as the root stack's cert_validation_records."
  value = {
    for dvo in aws_acm_certificate.preview.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

output "preview_wildcard_cname" {
  description = "Add this as a DNS CNAME record (DNS-only, not proxied) in Cloudflare -- one-time setup, routes every '*.<preview_domain>' session hostname to the ALB. No per-session DNS work needed after this."
  value = {
    name  = "*.${var.preview_domain}"
    type  = "CNAME"
    value = aws_lb.sandbox_preview.dns_name
  }
}

resource "aws_security_group" "sandbox_alb" {
  name        = "vibesdk-sandbox-alb"
  description = "Sandbox preview ALB -- HTTPS reachable only from var.allowed_ips, same lockdown as everywhere else in this migration"
  vpc_id      = aws_vpc.sandbox.id

  ingress {
    description = "Preview traffic -- IP allowlist, same as the main site and the direct-to-task rules this fronts"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_ips
  }

  egress {
    description     = "Forward to sandbox task dev-server port"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.sandbox_task.id]
  }
}

# Sandbox tasks now accept dev-server traffic from the ALB in addition to
# the pre-existing direct allowed_ips rule (main.tf) -- the direct rule is
# kept, not replaced, so hitting a task's raw public IP:3000 still works
# for debugging without going through DNS/the ALB.
resource "aws_security_group_rule" "sandbox_task_dev_server_from_alb" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.sandbox_alb.id
  security_group_id        = aws_security_group.sandbox_task.id
  description              = "Dev server port reachable from the preview ALB (TLS termination -- see alb.tf)"
}

resource "aws_lb" "sandbox_preview" {
  name               = "vibesdk-sandbox-preview"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.sandbox_alb.id]
  subnets            = [aws_subnet.sandbox_a.id, aws_subnet.sandbox_b.id]

  # Sandbox sessions are short-lived and this ALB has no persistent
  # state of its own to protect -- deletion protection would just be
  # friction on a stack that's already designed to be torn down and
  # rebuilt (see this directory's README).
  enable_deletion_protection = false
}

resource "aws_lb_listener" "sandbox_preview_https" {
  load_balancer_arn = aws_lb.sandbox_preview.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.preview.arn

  # No session's hostname matches until the orchestrator Lambda creates a
  # host-header rule for it (see alb-manager.ts) -- every listener needs a
  # default action, so unmatched requests (a stale/guessed/expired
  # hostname) get a plain 404 rather than falling through to some
  # arbitrary task.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "No preview at this address"
    }
  }
}

output "sandbox_preview_alb_dns_name" {
  value = aws_lb.sandbox_preview.dns_name
}

output "sandbox_preview_listener_arn" {
  value = aws_lb_listener.sandbox_preview_https.arn
}

output "sandbox_preview_vpc_id" {
  value = aws_vpc.sandbox.id
}
