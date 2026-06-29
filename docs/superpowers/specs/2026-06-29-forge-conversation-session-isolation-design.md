# Forge conversation ↔ Claude session isolation

## Problem

Creating a new conversation in a running forge and typing a message instead
replays the tail of an *old* conversation and hangs on "working…".

Root cause (verified): every conversation in a forge runs Claude in the same
working directory (`/workspace`), so Claude writes each session's transcript
into one shared directory:

```
/home/forge/.claude/projects/-workspace/<sessionUuid>.jsonl   (one per session)
```

The container transcript watcher (`lib/runtime/container-transcript-watcher.ts`,
introduced on `dev` in `e2f64ae`) tails **all** of them and adopts the first
session id it sees:

```sh
tail -n +1 -F /home/forge/.claude/projects/-workspace/*.jsonl
```

So a brand-new conversation's watcher (1) replays every old session's history
into the new conversation and (2) records an *old* session id as the new
conversation's `claudeSessionId`. The next connect then `--resume`s that old
session, desyncing the UI from the real (fresh) tmux session → "stuck on
working…". The `prisma.conversation.update()` "no record found" (`P2025`)
errors in the dashboard journal are a downstream symptom of the watcher trying
to set a session id that is already set.

The tmux layer is already correctly per-conversation (the tmux socket is
`claude-<conversationId>`); only the session-id/transcript binding is broken.

## Approach

Make each conversation's Claude session id **deterministic and known up front**
so the watcher reads exactly one file and nothing is ever guessed.
`claude --session-id <uuid>` (supported by the CLI) lets us pin it.

### Data flow

- `createConversation` generates a UUID and stores it as `claudeSessionId`.
  The column stays nullable (no migration); new rows are always populated.
- That id is the single source of truth for the Claude session **and** its
  transcript file `<uuid>.jsonl`.

### `lib/runtime/tmux-session.ts`

`ensureSession({ containerId, conversationId, sessionId })`:

- tmux `has-session` succeeds → already running; attach (unchanged).
- not running, `<dir>/<sessionId>.jsonl` **exists** → `claude --resume <sessionId>`
  (tmux server died but the transcript survived on the claude volume).
- not running, transcript absent → `claude --session-id <sessionId>` (first start).

### `lib/runtime/container-transcript-watcher.ts`

- Take `sessionId`; tail **only** `<dir>/<sessionId>.jsonl` (not `*.jsonl`).
- Remove the "first session id seen → `setClaudeSessionId`" block — the id is
  known, so there is nothing to detect. The watcher only appends messages.

### `lib/runtime/ws-server.ts`

- Pass the conversation's `claudeSessionId` to both `ensureSession` and the
  watcher; drop the `setClaudeSessionId` wiring.

### `lib/services/conversations.ts`

- `createConversation` sets the UUID.
- Remove `setClaudeSessionId` (its only caller was the watcher), which also
  removes the `P2025` journal noise.

## Out of scope (flagged, not fixed here)

`tail -n +1` reads a file from its first line, so on **reconnect** a watcher
re-appends a conversation's own history — a possible duplicate-message issue,
but independent of this cross-contamination bug. Check whether `appendMessage`
is idempotent during implementation and report; do not expand scope otherwise.

Existing (already-contaminated) conversations are not retro-fixed — only
conversations created after this change are clean.

## Testing (test-first)

- `container-transcript-watcher`: tails the specific `<sessionId>.jsonl`; never
  calls `setClaudeSessionId`; appends one message per parsed line.
- `tmux-session`: `ensureSession` issues `--session-id <uuid>` when no transcript
  exists and `--resume <uuid>` when it does; socket remains per-conversation.
- `conversations`: `createConversation` populates a non-null UUID
  `claudeSessionId`.

## Deploy

Requires a dashboard restart (`sudo systemctl restart crystal-forge.service`)
to take effect, as with the other runtime changes.
