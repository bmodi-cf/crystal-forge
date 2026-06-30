# Revert forge sessions to direct PTY streaming (drop tmux durability)

## Why

The tmux-based "durable Claude sessions" layer (merge `c9c7d29`, 2026-06-12)
replaced the working direct-streaming model and introduced session confusion in
the browser (pasted input not submitting, attach/takeover desync). The earlier
approach — streaming `docker exec … claude` straight to the browser — worked
reliably. Revert to it; keep the per-conversation session-id pinning fix
(2026-06-29 spec) so transcript history stays isolated.

This is a targeted revert of the *session-streaming layer only*, NOT a revert of
merge `c9c7d29` (which also carries unrelated good work: hmr-proxy, container
setup, runner, users).

## Approach

- **`ws-server.ts`** → one PTY per WS connection. Spawn
  `docker exec -i -t -w /workspace [-e creds] <cid> claude --dangerously-skip-permissions <sessionArgs>`
  and pipe it to the browser. `sessionArgs` = `--resume <id>` if the transcript
  already exists in the container, else `--session-id <id>` (first run). The id
  is the pinned `claudeSessionId` (set at create; `ensureClaudeSessionId`
  backfills legacy null rows).
- **Transcript watcher** still tails the single `<id>.jsonl` to persist history
  to the dashboard DB (the pinning fix is retained).
- **Removed**: `tmux-session.ts`, `session-registry.ts`, `end-session.ts`, the
  `/end` API route, and the UI end-session call. `useChatSession.end()` now just
  closes the socket (which kills the PTY).
- **`transcriptExists(containerId, sessionId)`** helper added next to
  `transcriptPath` to drive the resume-vs-fresh choice.

## Tradeoff

Not durable across browser disconnect: closing the tab kills the live Claude
process. Because the session id is pinned, reopening runs `--resume <id>` and
Claude reloads the transcript — so the conversation continues (process restarts,
history intact). Concurrency: a second connection for the same conversation is
rejected with close code 4409 (was tmux takeover/4410).

## Testing

- `ws-server`: spawns `docker exec … claude --session-id <id>` fresh and
  `--resume <id>` when the transcript exists; starts the watcher; 4401 / 4404 /
  4409 / 4500 close codes; input forwarding; socket close kills PTY + watcher.
- Retains `container-transcript-watcher` and `conversations` (pinning) tests.

## Deploy

Dashboard restart (`sudo systemctl restart crystal-forge.service`). The build
also regenerates `.next/types`, clearing the stale reference to the removed
`/end` route. No forge image rebuild needed.
