# Session-gated GitHub App installation tokens for forges

**Date:** 2026-07-16
**Status:** Design approved, pending implementation plan

## Problem

Each forge container is given a single long-lived GitHub credential as a
container-level `GH_TOKEN`, injected at container creation from the dashboard's
`FORGE_GIT_TOKEN` (a fine-grained PAT — `lib/services/runtime.ts:166`). The
agent's own `git` and `gh` operations authenticate against it via
`gh auth setup-git` (`lib/runtime/container-setup.ts:55`).

This has two problems:

1. **Broad, long-lived secret readable inside every forge.** Anyone with a
   shell in a forge — the developer, or the Claude CLI they drive — can read
   `GH_TOKEN` trivially (`gh auth token`, `env`, `/proc/self/environ`). Container
   isolation protects the host from the forge, not the forge's own secret from
   the forge's own user. A leaked PAT is valid for its full lifetime (up to a
   year) across **every** repo it can touch.
2. **Org policy friction.** The `CrystalFountainsInc` org rejects fine-grained
   PATs with lifetime > 366 days and gates repo access behind per-token
   approval, so the PAT is a recurring operational burden (expiry, re-approval,
   per-repo scoping) — the incident that motivated this work.

The GitHub App (`GITHUB_APP_*`, App ID 3646308, installation 144292228) is
already installed on the org and already mints installation tokens for the
initial clone (`getInstallationToken()` at `runtime.ts:180`). The App private
key never leaves the dashboard host — it is **not** present in any forge.

## Goal

Eliminate the long-lived PAT. Forges authenticate git/gh using **short-lived,
repo-scoped App installation tokens**, refreshed for as long as a conversation
is active and left to expire when the forge is idle.

Non-goals: changing how the dashboard itself uses the App (Octokit repo
management is unchanged); any change to the forge lifecycle beyond credential
delivery.

## Key facts grounding the design

- **A forge's `claude` process lives only while its pane's WebSocket is open.**
  `lib/runtime/ws-server.ts` spawns one PTY per WS connection and kills it on
  socket close (`ws.on('close')` → `pty.kill()`; also `pty.onExit`). There is no
  headless agent that keeps working after the pane closes. Therefore
  "conversation open" ⟺ "agent alive" ⟺ "git work possible" — a single,
  authoritative signal already tracked in the `sessions` map. An overnight run
  keeps its socket connected the whole time, so it stays covered.
- **Installation tokens are capped at ~1h by GitHub and cannot be extended.**
  Refreshing is mandatory; a token minted once at container creation is dead
  within the hour while forges run for days.
- **A running process's environment cannot be mutated from outside.**
  `docker exec -e GH_TOKEN=…` affects only the new exec shell, not the running
  PTY/`claude` or the git/gh it spawns. The refreshed credential must live in a
  **file** that git/gh re-read per invocation, not an env var.
- **git already delegates to `gh`.** `container-setup.ts:55` runs
  `gh auth setup-git`, so `git` calls `gh auth git-credential`. Making `gh`'s
  stored token the refreshed source feeds **both** git and gh from one place,
  re-read on every invocation (each `gh`/git op is a fresh process).

## Design

### Overview

A **session-gated token refresher** runs in the dashboard process (alongside the
WS server). While ≥1 conversation is open on a forge, it periodically mints a
fresh repo-scoped installation token and writes it into the forge's `gh`
credential store. When the last pane closes, refreshing stops; the leftover
token expires harmlessly. An idle forge holds only a dead token — nothing that
can mint more, and no long-lived secret.

Security posture vs. alternatives:

| standing secret in the forge | org PAT (today) | pull / credential-helper | **session-gated push (this design)** |
|---|---|---|---|
| what's readable there | year-long, all-repos PAT | per-forge mint secret | only the current ~1h token |
| when idle | still there | still there | goes stale, harmless |
| can it mint more tokens? | n/a | yes, for its repo | no — no minting credential in the forge |
| exposes App private key? | n/a | no | no |

### 1. Token minting — `lib/github`

Extend `GitHubClient` with a repo-scoped mint that returns token **and expiry**:

```ts
getScopedInstallationToken(repoFullName: string): Promise<{ token: string; expiresAt: string }>;
```

- `OctokitGitHubClient`: request a scoped token from the App auth
  (`repositoryNames: [<repo>]`, `permissions: { contents: 'write', pull_requests: 'write' }`).
  `contents: write` covers `git pull`/`push`; `pull_requests: write` covers
  `gh pr create`. Metadata read is implicit.
- `FakeGitHubClient`: return a deterministic fake token + far-future expiry so
  unit tests need no network.
- The clone path (`runtime.ts:180`) switches from `getInstallationToken()` to
  `getScopedInstallationToken(repoFullName)` — `runtime.ts` already has
  `repoFullName` in scope, and the clone only ever touches one repo. The old
  installation-wide `getInstallationToken()` is removed if it has no remaining
  callers.

### 2. In-forge credential mechanism

- The token is written to `gh`'s stored auth for `github.com` (the
  `oauth_token` field in `gh`'s `hosts.yml`), **not** an env var.
- `gh auth setup-git` (already present) keeps `git` delegating to `gh`, so one
  source feeds both; both re-read it per invocation.
- Container-level `GH_TOKEN` is **no longer set**, so nothing shadows the store
  (an env `GH_TOKEN` would take precedence over `hosts.yml` in `gh`).
- The token value is passed in the **exec environment, never argv** (same
  anti-leak discipline as the current clone at `container-setup.ts:38`), so it
  never lands in `docker ps`/process listings/logs.

### 3. Session-gated refresher — new `lib/runtime` module

A `TokenRefresher` keyed by `containerId`, ref-counted by open sessions:

- **`acquire(containerId, repoFullName)`** — on the first session for a
  container: mint immediately, write to the store, then schedule re-mint every
  **45 min** (under the 60-min token life; 15-min margin). Additional sessions
  on the same container bump the ref-count only.
- **`release(containerId)`** — decrement; at zero, clear the timer. The leftover
  token expires on its own.
- Injected wall clock and mint/exec functions so the interval and failure logic
  are unit-testable without real time, Docker, or GitHub.

**Failure handling (never kills a session):**

- Mint failure at session start → session still opens (local work is valuable);
  log + emit a one-line notice to the terminal; retry on a shortened interval
  (~5 min).
- Mid-session refresh failure → keep the last still-valid token; retry soon.
- If failures persist past token expiry, git/gh ops fail with GitHub's own auth
  error, which is logged — no silent wedging.

### 4. Wiring into the WS server — `lib/runtime/ws-server.ts`

- Add a `TokenRefresher` dependency (real default, overridable in tests).
- `acquire(handle.containerId, repoFullName)` after the forge handle loads and
  **before** the PTY spawns, so the first git op has a valid token.
- `release(handle.containerId)` in both `ws.on('close')` and `pty.onExit`,
  mirroring the existing `sessions.delete(cid)`.
- `repoFullName` per container is obtained from the forge lookup (extend the
  runtime handle to carry it, or read the forge row in the connect path).

### 5. Removals

- `lib/services/runtime.ts:166` — delete the `GH_TOKEN: env.FORGE_GIT_TOKEN`
  injection. The clone token becomes the scoped mint.
- `lib/env.ts` — drop `FORGE_GIT_TOKEN`.
- `.env.local` — remove `FORGE_GIT_TOKEN`.

## Testing

- **Unit:** scoped-mint call shape (fake client); `TokenRefresher` ref-count,
  interval scheduling, and failure/retry using an injected fake clock + fake
  mint + fake exec; `ws-server` acquire/release on connect / close / pty-exit
  via the existing dependency-injection seams.
- **No new e2e.** `GITHUB_CLIENT_MODE=fake` already exercises this path offline.
- `pnpm typecheck` + `pnpm lint` (the `no-octokit-outside-github` rule keeps the
  scoped mint inside `lib/github`).

## Rollout

1. Merge; update `.env.local` to remove `FORGE_GIT_TOKEN`.
2. Restart `crystal-forge.service` (picks up env change).
3. Stop + start each forge (restart recreates the container, applying the new
   credential path).

This is **independent of the immediate `second-set-of-eyes` pull** blocking
today: that still requires the PAT route unblocked (repo added to the token) or
a one-off manual token. This feature is the durable replacement, not the
same-day fix.

## Open questions

None outstanding. Decisions locked during brainstorming:

- Token scope: **per-repo, `contents:write` + `pull_requests:write`**.
- PAT: **removed entirely** (no fallback).
- Cadence: **45 min**. Failure behavior: **non-blocking**. Single refreshed
  source: **`gh` `hosts.yml`** (feeds both git and gh).
