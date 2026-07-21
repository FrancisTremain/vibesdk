# AWS replacement for ../../SandboxDockerfile -- that image is built FROM
# docker.io/cloudflare/sandbox, which bakes in a proprietary control-plane
# protocol with no public spec (see aws/sandbox-contract/README.md). This
# image starts from plain Bun and adds our own control-plane server
# (aws/sandbox-controlplane) instead.
#
# container/cli-tools.ts (monitor-cli) is reused unmodified -- it was
# already Cloudflare-independent, just running inside that image.

FROM oven/bun:1.1-slim

RUN apt-get update && \
	apt-get install -y --no-install-recommends git ca-certificates curl procps && \
	update-ca-certificates && \
	rm -rf /var/lib/apt/lists/* && \
	git config --global user.email "vibesdk-bot@tremain.dev" && \
	git config --global user.name "vibesdk sandbox" && \
	git config --global init.defaultBranch main

# --- monitor-cli (process monitoring / error+log storage), reused as-is ---
RUN mkdir -p /workspace/container /workspace/data /workspace/app
COPY container/ /workspace/container/
WORKDIR /workspace/container
RUN bun install && bun run build && \
	chmod +x cli-tools.ts && \
	ln -sf /workspace/container/cli-tools.ts /usr/local/bin/monitor-cli
RUN bunx tsc --version

# --- our own control-plane server ---
WORKDIR /workspace/controlplane
COPY aws/sandbox-controlplane/package.json aws/sandbox-controlplane/package-lock.json ./
RUN bun install --production
COPY aws/sandbox-controlplane/src/ ./src/

RUN chmod 755 /workspace/data /workspace/app

ENV CONTAINER_ENV=docker
ENV VITE_LOGGER_TYPE=json
ENV WORKSPACE_DIR=/workspace/app
ENV CONTROL_PORT=8080
ENV DEV_PORT=3000

EXPOSE 8080 3000

CMD ["bun", "run", "src/server.ts"]
