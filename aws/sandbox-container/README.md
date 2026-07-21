# sandbox-container

The container image for AWS sandbox instances (one Fargate task per
generation session). Runs [`aws/sandbox-controlplane`](../sandbox-controlplane)
as its entrypoint, plus the reused-unmodified `container/cli-tools.ts`
(`monitor-cli`) process-monitoring system.

## Build

The Dockerfile references `container/` and `aws/sandbox-controlplane/` by
path relative to the **repo root** -- build from there, not from this
directory:

```sh
cd /path/to/vibesdk
docker build -f aws/sandbox-container/Dockerfile -t vibesdk-sandbox .
```

## Push to ECR

```sh
aws ecr get-login-password --region ap-southeast-2 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com

docker tag vibesdk-sandbox:latest <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/vibesdk-sandbox:latest
docker push <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/vibesdk-sandbox:latest
```

`aws/infra/sandbox/` provisions the ECR repository this pushes to, along
with the ECS cluster/task definition that runs it.
