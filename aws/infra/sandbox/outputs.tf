output "sandbox_alb_dns_name" {
  description = "DNS name of the sandbox preview ALB. Point the preview subdomain's CNAME/ALIAS here once a real certificate and control-plane implementation exist."
  value       = aws_lb.sandbox.dns_name
}

output "sandbox_ecs_cluster_name" {
  value = aws_ecs_cluster.sandbox.name
}
