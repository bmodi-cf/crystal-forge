# Shared base image for every forge container: Node + pnpm + git + Claude CLI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential procps coreutils jq tmux wget poppler-utils \
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

# Playwright + a Chromium build, baked once so forges don't each run
# `npm i playwright-core && playwright install chromium` — a ~200MB download
# that a container recreate throws away, since only the workspace and Claude
# home volumes persist. Pinned to the version this repo uses (@playwright/test
# in package.json); a forge repo depending on a different version resolves its
# own package, wants a different browser revision, and downloads it as before.
#
# PLAYWRIGHT_BROWSERS_PATH deliberately points OUTSIDE /home/forge: that whole
# path is a per-forge named volume (CLAUDE_HOME in lib/runtime/paths.ts), and
# docker seeds a named volume from the image once and then pins that copy
# forever — so browsers under the default ~/.cache/ms-playwright would reach
# neither an existing forge (volume already populated) nor a later rebuild.
#
# The npm install must skip its postinstall download: the `playwright` package
# fetches all three engines by default. `--with-deps` is the apt half, and is
# why this runs before USER forge. a+rwX lets the agent add another revision
# without sudo (that copy lives in the container layer and dies on recreate).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright@1.59.1 \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rwX /ms-playwright

# Global npm installs are off the module resolution path for code in /workspace.
# NODE_PATH is the last-resort fallback, so `require('playwright')` works in a
# forge repo that has not installed it locally without shadowing one that has.
ENV NODE_PATH=/usr/local/lib/node_modules

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
      > /home/forge/.tmux.conf
