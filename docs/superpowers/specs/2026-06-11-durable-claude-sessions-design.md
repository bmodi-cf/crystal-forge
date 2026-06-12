# Durable Claude sessions across browser disconnect — Design

**Date:** 2026-06-11
**Status:** Approved (design); implementation plan pending
**Builds on:** `2026-06-03-forge-docker-isolation-design.md` (per-forge containers) and the
existing runtime WS layer (`lib/runtime/ws-server.ts`, `pty-session.ts`,
`container-transcript-watcher.ts`).

## Context

Today a Claude session's lifecycle is welded to the browser's WebSocket. The WS server runs
**once** in the long-lived Next.js process (`instrumentation.ts:29`) and holds an in-memory
`sessions` map; each browser connection spawns a server-side PTY running
`docker exec -i -t … claude …` (`ws-server.ts:54`). When the browser closes, `ws.on('close')`
fires `pty.kill()` + `watcher.stop()` (`ws-server.ts:91-95`) — so an in-flight prompt is
abandoned, its still-streaming output is no longer persisted, and there is no way to reattach
(a fresh connection spawns a fresh `claude`, with `--resume` only restoring *history*, not the
live run).

We want: **close the browser (or drop the network / sleep the laptop), reopen later, and be
reattached to the same still-running Claude session, including the output produced while away.**

### Explicitly out of scope

- **Surviving a dashboard restart / redeploy.** Restarts happen only during weekend
  maintenance, so this is acceptable. `bootCleanup` (`runner.ts:9`, called at
  `instrumentation.ts:7`) continues to wipe all forge containers/sessions on boot — and that
  weekly wipe doubles as our backstop reaper (see Lifecycle). No boot reconciliation, no
  out-of-process session state.
- **Idle-timeout reaping.** Because the weekly restart bounds orphan accumulation to one week,
  a mid-week idle reaper is not needed for v1. May be added later if resource pressure warrants.
- **Transcript dedup.** Not introduced by this work — see "Durability" below.

## Core idea

Move the durable Claude process *inside* the forge container, hosted by a per-conversation
**tmux session**. The dashboard stops *launching* `claude` over `docker exec` and instead
*attaches* to that tmux session:

```
Browser ⇄ WebSocket ⇄ [dashboard: docker exec -it … tmux attach] ⇄ tmux session ⇄ claude
                                  └ ephemeral "client"               └── durable, lives in container ──┘
```

The key inversion: **session liveness is owned by tmux, not by the dashboard's in-memory map.**
"Is this conversation live?" becomes `tmux has-session -t claude-<conversationId>` inside the
container — still true after the browser closes. The in-memory map degrades to "which
WebSocket is currently attached," used only for takeover and detach cleanup.

This also yields scrollback catch-up **for free**: on attach, tmux replays its pane history and
forces a redraw, so the reopened terminal repaints with the output it missed — no buffering
code on our side. (Approaches considered and rejected: keeping the PTY + a hand-built ring
buffer in the dashboard process — more code, and replaying raw bytes into a full-screen TUI is
fragile; and a detached background process with log tailing — breaks interactive input.)

## Components

### `lib/runtime/tmux-session.ts` (new)

Pure helper around `docker exec`, dependency-injected like the existing `spawnTail`/`spawnPty`
so it is unit-testable without a real container:

- `ensureSession({ containerId, conversationId, resumeSessionId, credEnv })` — if
  `tmux has-session` is false, create it: `tmux new-session -d -s claude-<cid> 'claude
  --dangerously-skip-permissions [--resume <resumeSessionId>]'`. Credentials are passed as
  today (`claudeCredentialsEnv()`, `ws-server.ts:51-52`). Returns whether it was newly created.
- `hasSession({ containerId, conversationId })` → boolean.
- `attachArgv({ containerId, conversationId })` → the `docker exec -i -t <container> tmux attach
  -t claude-<cid>` argv handed to `spawnClaudeSession`.
- `killSession({ containerId, conversationId })` → `tmux kill-session -t claude-<cid>`.

Session name: `claude-<conversationId>` (conversation ids are already filesystem/shell-safe).

### `lib/runtime/ws-server.ts` (rework)

The connection handler changes from *spawn-claude* to *ensure-then-attach*:

1. Verify ticket, load conversation + forge handle (unchanged, `ws-server.ts:42-49`).
2. **Takeover instead of reject.** The current `4409 "Conversation already active"`
   (`ws-server.ts:44`) is what blocks reattach. Replace it: if another WebSocket is currently
   attached for this conversation, detach it (close its socket + kill its attach-client PTY)
   and proceed. This prevents a dead/zombie browser tab from locking the user out.
3. `ensureSession(...)` (with `--resume conv.claudeSessionId` when set). If newly created, start
   the transcript watcher (see next).
4. Spawn the PTY against `attachArgv(...)` instead of the claude argv.
5. Stream bidirectionally exactly as today (`onData`→`ws.send`, ws message→`pty.write`, resize→
   tmux client resize via the existing resize path, `ws-server.ts:83-86`).
6. **`ws.on('close')` no longer kills the session.** It only `pty.kill()`s the *tmux client*
   (which detaches; claude keeps running) and clears the attached-socket entry. It does **not**
   stop the watcher and does **not** kill the tmux session.

### Transcript watcher → session lifecycle

Currently started per-connection and stopped on `ws.close` (`ws-server.ts:60-63, 93`). Move it
so it is **started once when the tmux session is created** (in the `ensureSession` path) and
**stopped only when the session is killed** (End session / forge stop / claude exit). Across
browser reconnects it keeps tailing continuously.

This is what makes background completion durable: output produced while no browser is attached
still lands in the DB. It also means the watcher never restarts within a dashboard lifetime, so
it never re-reads the transcript from the top — **no duplicate messages, no dedup code needed.**

## Data flow (attach / reattach)

1. Browser obtains a WS ticket (existing `lib/auth/ws-ticket`) and opens the socket.
2. Server verifies ticket; loads conversation + forge handle.
3. Takeover: detach any currently-attached socket for this conversation.
4. `ensureSession`: create the tmux session running claude if absent (start watcher); otherwise
   reuse the live one.
5. Spawn PTY = `docker exec -i -t <container> tmux attach -t claude-<cid>`; tmux replays
   scrollback → terminal repaints with missed output.
6. Bidirectional stream (unchanged plumbing).
7. `ws.close` → detach the tmux client only; claude + watcher keep running.

## Lifecycle — when a session ends

- **Explicit "End session"** — new authenticated API route → `killSession` + stop watcher +
  mark the conversation as ended. A control is added to the session UI.
- **Forge stopped** — existing `stopForge` path removes the container, taking its tmux sessions
  with it.
- **Claude exits on its own** — the tmux session ends; the next attach (or the watcher noticing
  the session is gone) cleans up. `pty.onExit` now reflects the *attach client* exiting (i.e.
  detach), not claude dying, so liveness is determined by `hasSession`, not PTY exit.
- **Weekly maintenance restart** — `bootCleanup` wipes all forge containers on boot; this is the
  backstop reaper that bounds orphan accumulation.

## Image change

`docker/forge-runtime.Dockerfile` currently installs no multiplexer (`:4-7`). Add `tmux` to the
`apt-get install` line, plus a minimal config (large `history-limit` for scrollback, no status
bar, `default-terminal tmux-256color`). **Migration note:** already-running containers won't
have tmux until rebuilt; existing sessions therefore won't gain durability until their container
is recreated. Acceptable given the weekly-restart cadence.

## Error handling

- **tmux missing / too old** (un-rebuilt container) — `ensureSession` detects failure; close the
  WS with a clear code and a user-facing message ("forge needs a rebuild to support persistent
  sessions") rather than a silent hang.
- **Container not running / crashed** — close `4404` as today (`ws-server.ts:49`).
- **Concurrent connects (attach race)** — serialize per-conversation with an in-process async
  lock so `has-session` → create → attach is atomic; the loser becomes a takeover.
- **Stale attached-socket entry** — takeover always supersedes, so a zombie entry can never lock
  out a real reconnect.

## Testing

- **Unit:** `tmux-session` helpers (mock `docker exec` like existing tests mock `spawnTail`/
  `spawnPty`); ws-server takeover + ensure-then-attach + detach-on-close (extend
  `ws-server.test.ts`, injecting `spawnPty`/`ensureSession`/`startWatcher`); watcher
  session-lifecycle (started once, survives simulated reconnects).
- **e2e (Playwright, fake mode):** limited — `GITHUB_CLIENT_MODE=fake` has no real
  tmux/container, so reattach can't be exercised end-to-end. The reattach/takeover/detach logic
  is covered by unit tests with injected fakes; this gap is noted rather than faked. A
  manual/pilot verification step (start prompt → close tab → reopen → see live session) covers
  the integration.

## Constraints & call-outs

- **Single Next.js process** remains assumed for the attached-socket map and per-conversation
  lock — fine for the pilot; because liveness is read from tmux, most of the design is already
  robust to that assumption being relaxed later.
- **No real-time persistence while the dashboard is down** — but since we don't survive restarts
  anyway, and the watcher runs whenever the dashboard is up, this is moot in practice.
- **Pre-existing resume-dup bug (out of scope):** reconnecting to a conversation with a stored
  `claudeSessionId` today restarts the watcher with `tail -n +1` and blindly re-`create`s every
  message (`appendMessage`, `conversations.ts:125`, is not idempotent; `parseTranscriptLine`
  even discards the line `uuid`, `transcript-watcher.ts:32`). This design triggers it *less*
  often (no per-reconnect watcher restart). Logged here as a separate optional fix — make
  `appendMessage` idempotent on the transcript line `uuid` + track a per-conversation cursor —
  not folded into this work.
