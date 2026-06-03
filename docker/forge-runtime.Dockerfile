# Shared base image for every forge container: Node + pnpm + git + Claude CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Pinned Claude Code CLI. Update the version to match the host's `claude --version`.
RUN npm install -g @anthropic-ai/claude-code@1.0.44

RUN useradd -m -d /home/forge -s /bin/bash forge \
 && mkdir -p /workspace /pnpm-store \
 && chown -R forge:forge /workspace /pnpm-store

ENV HOME=/home/forge
USER forge
WORKDIR /workspace
RUN pnpm config set store-dir /pnpm-store
