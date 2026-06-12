# Shared base image for every forge container: Node + pnpm + git + Claude CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils jq tmux \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Pinned Claude Code CLI. Update the version to match the host's `claude --version`.
RUN npm install -g @anthropic-ai/claude-code@1.0.44

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

# tmux hosts the durable Claude session (see lib/runtime/tmux-session.ts).
# Large scrollback so a reattaching browser repaints prior output; no status
# bar; 256-color terminal to match the xterm client.
RUN printf '%s\n' \
      'set -g history-limit 100000' \
      'set -g status off' \
      'set -g default-terminal "tmux-256color"' \
      'set -g escape-time 0' \
      'set -g mouse on' \
      > /home/forge/.tmux.conf
