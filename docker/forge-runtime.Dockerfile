# Shared base image for every forge container: Node + pnpm + git + Claude CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils jq wget \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (`gh`) — not in Debian's default repos, so add the official apt
# source. Users authenticate themselves with `gh auth login` inside the forge;
# the credentials persist on the home volume (see CLAUDE_HOME in lib/runtime/paths.ts).
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Pinned Claude Code CLI. Update the version to match the host's `claude --version`.
RUN npm install -g @anthropic-ai/claude-code@2.1.195

RUN useradd -m -d /home/forge -s /bin/bash forge \
 && mkdir -p /workspace /pnpm-store /home/forge/.claude \
 && chown -R forge:forge /workspace /pnpm-store /home/forge
# Pre-creating /home/forge/.claude as `forge` ensures the per-forge named volume
# mounted there initializes with forge ownership (Docker copies the image path's
# permissions into a fresh volume), so the agent can write its credentials.

ENV HOME=/home/forge
USER forge
WORKDIR /workspace
RUN pnpm config set store-dir /pnpm-store
# pnpm 10+ blocks dependency build scripts by default and exits non-zero on any
# unapproved ones (e.g. @prisma/engines, sharp), which breaks `pnpm install` and
# `prisma generate`. The forge runs in a sandbox container, so allow all builds.
RUN pnpm config set dangerouslyAllowAllBuilds true
