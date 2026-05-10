# Crystal Forge — Open Forge (Split View + Embedded Claude Code) Design

- **Date:** 2026-05-10
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Add a `/forges/[id]` route with a split-pane interface — embedded Claude Code session on the left, iframe of the running forge on the right. Persist every Claude session as a DB-backed transcript (schema already provisioned) so business users' and devs' work on each forge is reproducible. Builds on `2026-05-08-forge-orchestration-design.md`.

## 1. Summary

Today the dashboard offers Start / Stop / Open. "Open" launches the forge in a new browser tab — the user is then on their own to edit the cloned repo locally with whatever editor they like.

This slice replaces "Open" with an in-harness experience:

1. Click a forge → land on `/forges/[id]`.
2. Right pane: the running forge in an iframe.
3. Left pane: a list of past Claude conversations for this (forge, user), and an active xterm.js terminal connected to a `claude` subprocess running with `cwd = forgeClonePath(slug)`.
4. Every message in every Claude session is mirrored into the harness's existing `Conversation` / `Message` tables. The intent is reproducibility: an admin can later see exactly which prompts and tool calls produced the current state of any forge.

Container isolation, per-user Claude credentials, per-user GitHub keys, and auto-commit are explicit non-goals — each becomes its own follow-up slice.

## 2. Goals & Non-Goals

### Goals
- A forge writer (creator or admin, per existing `canWriteForge`) can navigate from the dashboard into a forge, see the running instance, and chat with Claude Code about the cloned repo.
- The chat experience is the *real* Claude Code TUI — same prompt, slash commands, MCP servers, skill system, tool use — not a re-implementation.
- Every Claude session is persisted as a queryable record: who, when, what was said, what tools ran, what they returned. Storage shape is the Anthropic API native message format, encoded as JSON.
- A user can navigate away from a conversation and come back to it: the PTY child dies on unmount, but `claude --resume <session-id>` restores context on return.
- Conversations survive harness restarts (DB-backed). `claude --resume` continues to work because Claude Code's own session storage is on the host filesystem, separate from the harness lifecycle.
- The credential source for the spawned `claude` subprocess goes through one helper (`claudeCredentialsEnv()`), so a future slice can swap to per-user credentials without touching the spawn site.
- Multiple forges can be open in different tabs; each tab is its own conversation against its own clone dir. (Multiple tabs against the *same* conversation is rejected.)
- The UI degrades gracefully when the forge is not running: Stopped / Crashed / Setup-failed states show a status card mirroring the dashboard's badge, with the same Start button.

### Non-Goals (this slice)
- **No Docker isolation.** Claude Code runs on the harness host, with `cwd` set to the clone dir. Trust boundary: the user trusts the model not to escape the clone tree. Documented as a known limitation; full isolation lands when the docker-per-forge migration ships.
- **No per-user credentials.** Every chat uses the harness operator's `~/.claude/` and SSH/GitHub keys today. The credential helper is the seam where this changes later.
- **No auto-commit.** Claude commits through its own tool use, the same way it does in your daily flow. We don't add a "commit when done" button or a per-turn auto-commit policy.
- **No multi-tab same-conversation.** A second WebSocket attempt for an already-connected conversation is rejected (HTTP 409). No takeover, no read-only spectator mode.
- **No global audit / cross-forge search UI.** The records are queryable from psql; a UI is a follow-up.
- **No conversation rename / delete UI.** Conversation titles are auto-derived from the first user prompt and immutable in this slice.
- **No transcript replay / time-travel UI** — the records are stored but only listed and reopened; rendering historical tool-use as a virtual terminal is out of scope.
- **No file-system browser.** The instance panel shows the running app via iframe; there's no separate "files" tree.
- **No markdown rendering of past messages on the left.** History is shown as conversation titles; the active session is rendered through xterm.js. (Rendering structured assistant content in HTML is a follow-up.)

## 3. Architecture

### A. Routing & navigation

New route `app/(app)/forges/[id]/page.tsx` (RSC):
- Authenticates via existing `auth()` helper.
- Fetches the forge via `getForge(user, id)` (existing service; throws ForbiddenError if user can't read it).
- Fetches the runtime entry via `getRuntimeService().getRuntime(user, id)` (may be `null`).
- Fetches the conversation list via `listConversations(user, forgeId)`.
- Renders `<ForgePageClient ...>` with the data.

Dashboard wiring (`app/(app)/dashboard/ForgeCard.tsx`):
- The current "Open" anchor in `ForgeCardRuntime` points at `http://localhost:<port>` and is shown only when `status === 'running'`.
- New behaviour: clicking the **forge name / card body** navigates to `/forges/[id]`. The "Open" link becomes a tiny "↗ standalone" icon inside the new page (so direct localhost access is still available when wanted) — not on the card itself.

### B. Page layout (`ForgePageClient.tsx`)

```
┌──────────────────────────────────────────────────────────────────┐
│ ← back to forges                       Marketing Fru Fru  [⏹]   │
├──────────────────────────┬───────────────────────────────────────┤
│ ┌──────────────────────┐ │                                       │
│ │ Conversations    + │ │                                       │
│ │ ──────────────────── │ │                                       │
│ │ ● Setup auth flow    │ │                                       │
│ │   2026-05-09 14:23   │ │                                       │
│ │ ○ Add quote builder  │ │   <iframe                             │
│ │   2026-05-08 09:11   │ │     src="http://localhost:3007"       │
│ │ ○ First steps        │ │     ↗ standalone                      │
│ │   2026-05-07 12:45   │ │                                       │
│ ├──────────────────────┤ │                                       │
│ │  xterm.js terminal   │ │                                       │
│ │  (active session)    │ │                                       │
│ │                      │ │                                       │
│ │  > _                 │ │                                       │
│ └──────────────────────┘ │                                       │
└──────────────────────────┴───────────────────────────────────────┘
   40%                          60%
```

- Two-column flex with a draggable splitter. Default 40/60. Min widths: 280px left, 320px right.
- **Left:** conversation list (max 8 visible, scrollable below) + a New button. When a conversation is selected, the bottom of the left pane becomes the active xterm.js terminal.
- **Right:** iframe of `http://localhost:<port>` when forge `status === 'running'`. Otherwise a centered status card matching the dashboard's badges (Stopped / Starting / Crashed / Setup-failed) with the same controls. **No auto-start.** A Start click here uses the existing `POST /api/forges/[id]/start` route. Polling for runtime status reuses the existing `useForgeRuntimes` hook.
- Top bar: forge name, runtime status pill, Stop button (when running), a "← back" link.

### C. Claude session lifecycle

Per active conversation:

1. The user clicks an existing conversation OR clicks `+ New`.
2. The client makes `POST /api/forges/[id]/conversations` (new) or `POST /api/forges/[id]/conversations/[convId]/connect` (resume) — the server returns a short-lived **PTY ticket**: `{ wsUrl: "ws://localhost:3100/", token: "<signed>", conversationId }`.
3. The client opens a WebSocket to `wsUrl` with `?token=<token>` in the query string. Server validates the token (HMAC over `{conversationId, userId, exp}`, 60-second TTL).
4. Server spawns or reuses a PTY child:
   - `cmd = 'claude'`, `args = newConversation ? [] : ['--resume', conversation.claudeSessionId]`.
   - `cwd = forgeClonePath(slug)`.
   - `env = { ...process.env, ...claudeCredentialsEnv() }` — `claudeCredentialsEnv()` is initially `{}` (inherits the harness's `~/.claude/`), but the helper is the single source so future slices can override `HOME`, `CLAUDE_CONFIG_DIR`, etc.
   - PTY size matches the client's `cols/rows` (sent in the first WS message).
5. The WebSocket is bidirectional:
   - Client → server: keypresses (raw bytes) and resize events (`{type: 'resize', cols, rows}`).
   - Server → client: PTY output bytes streamed as binary frames.
6. The server starts a **transcript watcher** for this conversation (see §D) so messages land in the DB as Claude writes them.
7. On client disconnect (page unmount, tab close): the PTY child receives SIGTERM. Transcript watcher captures any final `assistant` message that landed before exit. Conversation row stays; `claudeSessionId` (if captured) is persisted so a later resume works.

A per-conversation in-memory `Map<conversationId, ActiveSession>` ensures one PTY per conversation. A second connect attempt for a conversation already in the map returns 409 Conflict.

### D. Transcript persistence (the audit log)

**Where Claude Code writes session data**

Claude Code stores per-session JSONL transcripts under `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `encoded-cwd` is the absolute clone path with `/` → `-`. This is the existing on-disk format used by the CLI; we depend on it as a structured-data source rather than parsing the PTY byte stream (which is full of ANSI escapes). The first event in each transcript carries the session UUID — we capture that and store it on the `Conversation` row so `--resume` works on next visit.

**The watcher**

`lib/runtime/transcript-watcher.ts`:

```ts
type WatcherDeps = {
  prisma: PrismaClient;
  fs: typeof import('node:fs');
  // ...injectable for tests
};

export function startTranscriptWatcher(
  conversationId: string,
  cloneDir: string,
  deps: WatcherDeps,
): { stop: () => void };
```

Behaviour:
- Computes the project dir (`encodedCwd(cloneDir)`).
- For a *new* conversation: records the harness's spawn time `t0`, then watches the project dir for `.jsonl` files appearing or growing after `t0`. Claims the file whose mtime is highest among those that satisfy `mtime >= t0` within a 30-second window. This avoids attributing a stray `claude` invocation from another terminal (whose mtime is older than `t0`) to this conversation.
- For a *resumed* conversation: tails the file at `~/.claude/projects/<encoded-cwd>/<conversation.claudeSessionId>.jsonl` directly.
- For each new line: parses JSON, maps to a `Message` row via `appendMessage(conversationId, payload)`.
- The first parsed line typically contains the session UUID — if we don't have it on `Conversation` yet, write it back via `setClaudeSessionId`.
- Also detects when the file is closed/rotated (Claude finished). Cleans up watcher.

**Mapping rules**

Anthropic API messages have `role: 'user' | 'assistant'` and `content` that is either a string or an array of content blocks (`text`, `tool_use`, `tool_result`, `thinking`, `image`, …). The schema's existing `MessageRole` (`user | assistant`) is sufficient. Stored shape per `Message`:

- `role`: `user` or `assistant` (verbatim from the transcript line).
- `content`: the entire content array as JSON (or a `[{type:'text', text: '…'}]` wrap if the source was a bare string).
- `createdAt`: from the transcript line's timestamp if present; otherwise `now()`.

This preserves tool-use and tool-result blocks losslessly.

**Schema migration** (prisma): `add_claude_session_and_jsonb_message_content`

```prisma
model Conversation {
  // ... existing
  claudeSessionId String?  @map("claude_session_id") @db.Uuid
  // ... existing
}

model Message {
  // ... existing
  content Json    // was String — Postgres column type changes to jsonb
  // ... existing
}
```

Prisma will generate a migration that:
- Adds `claude_session_id` column to `conversations` (nullable uuid).
- Casts `messages.content` to `jsonb`. We do this with a `USING` clause:
  ```sql
  ALTER TABLE messages ALTER COLUMN content TYPE jsonb USING jsonb_build_array(jsonb_build_object('type', 'text', 'text', content));
  ```
  to wrap any pre-existing text rows in the new array shape. (In practice this slice's predecessor never wrote messages in production, so the migration affects zero rows; the `USING` clause is correct-by-construction either way.)

### E. WebSocket / PTY server

**Why a separate port**

Next 16's App Router doesn't natively serve WebSockets through `route.ts` handlers. The two ergonomic options are (a) running a separate `ws` server inside `instrumentation.ts` on a dedicated port, or (b) using Server-Sent Events for output and REST for input. SSE adds round-trip latency for every keystroke (poor TUI experience) and complicates flow control. We pick (a).

**Implementation**

`lib/runtime/ws-server.ts`:

```ts
export function startWsServer(opts?: { port?: number }): { stop: () => void };
```

- Lives alongside `runner.ts` in `lib/runtime`. Uses `ws` (npm package, ~60kb) for the server and `node-pty` for the PTY.
- Defaults: `port = env.CRYSTAL_FORGE_WS_PORT ?? 3100`.
- Started from `instrumentation.ts`'s `register()` after `bootCleanup()`. Stop hook is captured but unused (no graceful shutdown story yet — consistent with the rest of the runtime layer).
- A small `Map<conversationId, ActiveSession>` lives at module scope. Each `ActiveSession` holds the PTY handle, the WebSocket, and the watcher's `stop()` fn.

**Auth**

- The browser asks `POST /api/forges/[id]/conversations/[convId]/connect` for a ticket. The route checks `canWriteForge`, then issues a token signed with HMAC-SHA-256 over `{conversationId, userId, exp: now + 60s}` using a key from `env.CRYSTAL_FORGE_WS_SECRET` (16+ chars).
- The WS server validates the token on the upgrade request. Token reuse beyond expiry is rejected. (No nonce store — the 60s TTL is short enough that replay is not a concern in this single-machine dev tool.)

**Lifecycle**

- On WS open: validate ticket → look up conversation → spawn PTY (or reject 409 if active) → start watcher → wire bidirectional pipe.
- On WS close: SIGTERM PTY → wait up to 5s → SIGKILL. Stop watcher. Remove from Map.
- On WS error: same cleanup as close.

### F. Component / file layout

```
app/(app)/forges/[id]/
├── page.tsx                       # RSC: fetch + render shell
├── ForgePageClient.tsx            # split-pane layout, splitter
├── ConversationList.tsx           # list + New button
├── ChatPanel.tsx                  # xterm.js + WS client
├── InstancePanel.tsx              # iframe / status card
├── useChatSession.ts              # connect/disconnect/reconnect logic
├── ForgePageClient.test.tsx       # smoke test
├── ConversationList.test.tsx
└── ChatPanel.test.tsx             # mocked WS

app/api/forges/[id]/conversations/
├── route.ts                       # GET list, POST create
├── [conversationId]/route.ts      # GET full history
└── [conversationId]/connect/route.ts  # POST → ticket

lib/services/
├── conversations.ts               # NEW
└── conversations.test.ts          # NEW

lib/runtime/
├── transcript-watcher.ts          # NEW
├── transcript-watcher.test.ts
├── ws-server.ts                   # NEW
├── ws-server.test.ts
├── pty-session.ts                 # NEW — node-pty wrapper
└── pty-session.test.ts

lib/auth/
└── ws-ticket.ts                   # NEW — HMAC sign/verify
└── ws-ticket.test.ts

prisma/migrations/
└── <timestamp>_add_claude_session_and_jsonb_message_content/
    └── migration.sql

lib/env.ts                         # MODIFIED — CRYSTAL_FORGE_WS_PORT, CRYSTAL_FORGE_WS_SECRET
instrumentation.ts                 # MODIFIED — also start the WS server
app/(app)/dashboard/ForgeCard.tsx  # MODIFIED — link card body to /forges/[id]
prisma/schema.prisma               # MODIFIED — Conversation.claudeSessionId, Message.content Json
```

## 4. Data Model

### Schema changes

```prisma
model Conversation {
  id              String   @id @default(uuid()) @db.Uuid
  forgeId         String   @map("forge_id") @db.Uuid
  createdById     String   @map("created_by") @db.Uuid
  title           String   @default("New conversation")
  claudeSessionId String?  @map("claude_session_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  forge     Forge     @relation(fields: [forgeId], references: [id], onDelete: Cascade)
  createdBy User      @relation(fields: [createdById], references: [id], onDelete: Restrict)
  messages  Message[]

  @@index([forgeId, createdById])
  @@map("conversations")
}

model Message {
  id             String      @id @default(uuid()) @db.Uuid
  conversationId String      @map("conversation_id") @db.Uuid
  role           MessageRole
  content        Json        // was String
  createdAt      DateTime    @default(now()) @map("created_at") @db.Timestamptz

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
  @@map("messages")
}
```

### Service contracts (`lib/services/conversations.ts`)

```ts
export async function listConversations(currentUser: SessionUser, forgeId: string): Promise<ConversationDto[]>;
export async function createConversation(currentUser: SessionUser, forgeId: string): Promise<ConversationDto>;
export async function getConversation(currentUser: SessionUser, conversationId: string): Promise<ConversationWithMessagesDto>;
/** Called by the transcript watcher only — not exposed via API. */
export async function appendMessage(conversationId: string, payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date }): Promise<void>;
/** Idempotent — only writes if not already set. */
export async function setClaudeSessionId(conversationId: string, sessionId: string): Promise<void>;
/** Auto-derives a title from the first user prompt's flattened text content. Idempotent. */
export async function maybeBackfillTitle(conversationId: string): Promise<void>;
```

ACL:
- `list` / `create` / `get`: gated by `canReadForge` (creator or group overlap or admin). Note this is read-side authorization for conversations the user themselves did not create — see §5 row "user reads someone else's conversation".
- The connect-ticket route is gated by `canWriteForge` (only writers can spawn a Claude session).

### DTO shapes

```ts
export type ConversationDto = {
  id: string;
  forgeId: string;
  createdBy: { id: string; name: string };
  title: string;
  hasClaudeSessionId: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessagesDto = ConversationDto & {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: unknown;     // pass-through from JSON
    createdAt: string;
  }>;
};
```

## 5. Error Handling & Edge Cases

| Failure | Behaviour |
|---|---|
| Forge `id` not found / not visible | Page returns 404 (existing `getForge` throws NotFound; the RSC catches and Next renders not-found). |
| Forge is `stopped` / `crashed` / `setup-failed` when page loads | Right pane shows the matching status card with the same Start button as on the dashboard. Left pane fully usable — Claude can chat about the code without a running app. |
| Forge transitions Running → Crashed mid-session | Iframe shows whatever the server returns (probably error). Status pill flips to Crashed via the existing 5s liveness loop. Chat is unaffected (Claude is independent of the dev server). |
| User without `canWriteForge` opens the page | Page renders read-only: conversation list visible, but `+ New` is disabled and connecting to an existing conversation returns 403. (Justification: traceability requires read access for non-writers, but we don't want them spending tokens or editing files.) |
| User opens a conversation already connected from another tab | Connect ticket request returns 409 Conflict. UI shows "This conversation is already active in another tab — close that tab to take over here." |
| Claude binary not found on PATH | PTY spawn fails immediately; WebSocket sends an error frame `{type:'fatal', message:'claude not on PATH'}` and closes. UI surfaces a clear message with a hint to install. |
| Transcript JSONL not produced (e.g., user runs `claude --print`) | Watcher times out after 30s without seeing a transcript file → marks the conversation `claudeSessionId = null`, logs a warning. Chat still works in the PTY; persisted record will be empty. |
| Conversation has stale `claudeSessionId` whose JSONL file no longer exists | `claude --resume <id>` fails. WS server detects PTY exit within ~2s, sends `{type:'fatal', message:'cannot resume: session not found'}` and closes. UI offers "Start a new conversation". |
| WS server port 3100 already in use at boot | `instrumentation.ts` logs the error and falls back to port 0 (random). The connect route reads the actually-bound port from a module export. |
| WS ticket expires before client connects | Server rejects upgrade with 401. UI requests a fresh ticket and retries once. |
| Two transcript files appear in the project dir within the watcher's claim window | Pick the newest one by mtime. Log the other as "ignored — second file in window". |
| Disk full during message append | `appendMessage` throws → watcher logs and skips. Chat continues, but DB record is incomplete. (Acceptable for this slice; followup could buffer to retry.) |
| Schema migration runs against existing rows | The `USING jsonb_build_array(jsonb_build_object(...))` clause wraps the old text in the new shape. Test against a snapshot DB before merging. |
| Browser closes during PTY stream | WS `close` event fires server-side → SIGTERM → cleanup. PTY child usually exits within 5s; SIGKILL if not. Watcher persists any final messages it had time to flush. |
| `node-pty` native module fails to build on user's machine | Documented prereq in the README. Followup could fall back to non-PTY spawn (loses TUI rendering) — out of scope here. |

## 6. Testing

### Unit
- `lib/services/conversations.ts` — list/create/get with ACL (read for visible forges, write-gate on connect), `appendMessage` shape correctness, `setClaudeSessionId` idempotency, `maybeBackfillTitle` derives from first user message.
- `lib/auth/ws-ticket.ts` — sign/verify happy path, expired token rejected, tampered token rejected, wrong conversation in token rejected.
- `lib/runtime/transcript-watcher.ts` — given a fake fs (memfs / injected), simulate JSONL lines being appended; assert correct `appendMessage` calls in order; assert session-id capture on the first line.
- `lib/runtime/pty-session.ts` — small wrapper around `node-pty`; integration-style test that spawns `bash -c "echo hi; sleep 0.2"` and asserts output bytes flow through.
- `lib/runtime/ws-server.ts` — connect with valid ticket → ok; expired ticket → 401; second connection for same conversation → 409; client disconnect → PTY child dies and is removed from the map.

### Service
- Concurrent `connect` for the same conversation: only one wins.
- Forge deletion cascades conversations (existing behaviour, but verify the new `claude_session_id` column doesn't block).

### E2E (Playwright)
- Open the dashboard, click into Aquaflow Designer (which has a pre-warmed clone fixture), see the split layout.
- Right pane shows Stopped status card (forge not running). Click Start. Wait for Running. Iframe loads "Welcome to Aquaflow Designer".
- Click `+ New` in left pane. Type a prompt ("hello"). Wait for assistant text. Reload the page. Conversation appears in the list with the title derived from the first prompt.
- Pre-warmed fixture replaces `claude` with a stub that emits a deterministic JSONL transcript (no real Anthropic API call in CI). Stub: a small node script under `tests/e2e/fixtures/claude-stub.js` that prints to a PTY and writes the JSONL transcript to the expected path. The test sets `PATH` to find the stub before the real `claude`.

### Manual
- Open two forges in two tabs. Confirm chat in tab A doesn't bleed into tab B.
- Start a conversation, kill the dev server (`TaskStop`), restart, return to the page, observe history persists, click the conversation, observe `--resume` continues.
- Send a message that triggers a tool call (e.g., "list files") and confirm the persisted `Message.content` for that turn includes a `tool_use` block with the tool name and args.

## 7. Out-of-Scope Follow-ups

- **Docker-per-forge runtime** — security boundary so Claude can't reach the harness's pg, other forges' code, or the host. The biggest follow-up; sized similarly to the orchestration slice.
- **Per-user Claude credentials** — `claudeCredentialsEnv()` becomes user-aware, reading from a per-user encrypted store (e.g., NextAuth account-linked credentials).
- **Per-user GitHub keys** — same pattern; the GitHub App becomes a per-user installation.
- **Auto-commit policy** — at end-of-conversation, end-of-tool-burst, or user-confirmed.
- **Read-only spectator** — multiple users watching one conversation in real time.
- **Conversation rename / delete UI**.
- **Cross-forge audit / search UI** — a `/admin/audit` view.
- **Markdown rendering of past messages** — render historical assistant content as HTML (not just terminal-style).
- **File browser / diff view** in the chat panel.
- **Streaming structured events to the client over the WS** — currently we stream raw PTY bytes; a richer protocol with framed events (e.g., distinguish PTY output from harness-side notifications) could replace the dual-channel transcript-watcher + PTY model.
- **Conversation export** (`pg_dump` per conversation, or JSONL re-export).

## 8. File-by-File Changes Summary

### New (harness)

- `app/(app)/forges/[id]/page.tsx`
- `app/(app)/forges/[id]/ForgePageClient.tsx` (+ test)
- `app/(app)/forges/[id]/ConversationList.tsx` (+ test)
- `app/(app)/forges/[id]/ChatPanel.tsx` (+ test)
- `app/(app)/forges/[id]/InstancePanel.tsx`
- `app/(app)/forges/[id]/useChatSession.ts`
- `app/api/forges/[id]/conversations/route.ts`
- `app/api/forges/[id]/conversations/[conversationId]/route.ts`
- `app/api/forges/[id]/conversations/[conversationId]/connect/route.ts`
- `lib/services/conversations.ts` (+ test)
- `lib/runtime/transcript-watcher.ts` (+ test)
- `lib/runtime/pty-session.ts` (+ test)
- `lib/runtime/ws-server.ts` (+ test)
- `lib/auth/ws-ticket.ts` (+ test)
- `prisma/migrations/<timestamp>_add_claude_session_and_jsonb_message_content/migration.sql`
- `tests/e2e/forge-open.spec.ts` (+ `tests/e2e/fixtures/claude-stub.js`)

### Modified

- `lib/env.ts` — add `CRYSTAL_FORGE_WS_PORT` (default 3100), `CRYSTAL_FORGE_WS_SECRET` (z.string().min(16) when in production).
- `instrumentation.ts` — also `startWsServer()` after `bootCleanup()`.
- `app/(app)/dashboard/ForgeCard.tsx` — wrap the card body in a `<Link href={"/forges/" + forge.id}>`. Move the small "↗ standalone" link out of the runtime row (it now lives inside the new page).
- `prisma/schema.prisma` — `Conversation.claudeSessionId`, `Message.content: Json`.

### Dependencies (new)

- `node-pty` (~runtime; native build prereq).
- `ws` (~runtime).
- `@xterm/xterm`, `@xterm/addon-fit` (client only).

## 9. Slice Sequencing

This slice depends on the orchestration slice (`2026-05-08-forge-orchestration-design.md`, shipped) — without a running forge there's nothing to iframe and nothing to put a clone dir under.

Ship order from here: open-forge (this slice) → docker-per-forge migration → per-user credentials → auto-commit. Each is independent enough to slip if priorities change.
