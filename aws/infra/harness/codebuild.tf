/**
 * Builds and pushes aws/agent-harness's Docker image to
 * aws_ecr_repository.harness -- the alternative to a local `docker
 * build` (this deployment has no local Docker daemon available) or
 * driving AWS CloudShell by hand through the console. CodeBuild's
 * standard image ships Docker-in-Docker when privileged_mode is set,
 * so this is the same "docker build utility" already used for
 * one-off builds elsewhere in this migration, just expressed as
 * infra-as-code instead of ad hoc CloudShell commands.
 *
 * Source is the public GitHub repo directly (no webhook/trigger --
 * this is invoked manually via `aws codebuild start-build
 * --source-version <branch>` after a push, not on every commit).
 */

resource "aws_iam_role" "harness_image_codebuild" {
  name = "vibesdk-harness-image-codebuild"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "harness_image_codebuild" {
  name = "vibesdk-harness-image-codebuild"
  role = aws_iam_role.harness_image_codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
      {
        # GetAuthorizationToken is only ever authorized against "*" --
        # ECR does not support resource-scoping this specific action.
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Resource = aws_ecr_repository.harness.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "harness_image_codebuild" {
  name              = "/aws/codebuild/vibesdk-harness-image"
  retention_in_days = 7
}

resource "aws_codebuild_project" "harness_image" {
  name          = "vibesdk-harness-image"
  service_role  = aws_iam_role.harness_image_codebuild.arn
  build_timeout = 30

  source {
    type      = "GITHUB"
    location  = "https://github.com/FrancisTremain/vibesdk.git"
    buildspec = <<-EOT
      version: 0.2
      phases:
        pre_build:
          commands:
            - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URL
        build:
          commands:
            - docker build -f aws/agent-harness/Dockerfile -t $ECR_REPO_URL:latest .
        post_build:
          commands:
            - docker push $ECR_REPO_URL:latest
    EOT
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.harness_image_codebuild.name
    }
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URL"
      value = aws_ecr_repository.harness.repository_url
    }
  }
}
