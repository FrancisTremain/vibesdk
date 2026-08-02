# Harness container for aws/infra/harness's Fargate task. Plain Node (not
# Bun, unlike aws/sandbox-container) -- this is a fresh package with no
# legacy Bun-based tooling to reuse, and Node is the Claude Agent SDK's
# most-tested runtime for spawning its own bundled Claude Code CLI
# subprocess (the SDK ships a native linux-x64/linux-arm64 binary as an
# optional dependency -- see aws/agent-harness/README.md).

FROM node:20-slim

RUN apt-get update && \
	apt-get install -y --no-install-recommends ca-certificates && \
	update-ca-certificates && \
	rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/harness
COPY aws/agent-harness/package.json aws/agent-harness/package-lock.json ./
RUN npm install --omit=dev
COPY aws/agent-harness/src/ ./src/
COPY aws/agent-harness/tsconfig.json ./

ENV CONTROL_PORT=8081

EXPOSE 8081

CMD ["npx", "tsx", "src/server.ts"]
