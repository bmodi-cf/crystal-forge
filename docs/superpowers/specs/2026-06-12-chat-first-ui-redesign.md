# Chat-First UI Redesign

**Date:** 2026-06-12
**Status:** Approved for implementation

## Problem

The current chat panel stacks a `ConversationList` (unbounded vertical list), a `ConversationHistory` (renders all transcript entries including raw tool calls and tool results), and an xterm terminal strip (replays the same PTY output already shown above). This produces three visible problems:

1. **Duplication** — tool output appears twice: once as message blocks in the React history, once in the terminal strip below.
2. **Noise** — `ConversationHistory` renders every `tool_use` and `tool_result` block as a message bubble, flooding the view with directory trees, file contents, and internal Claude monologue.
3. **Growing list** — the conversation list stacks vertically with no bound, taking increasing space as sessions accumulate.

## Goals

- Single, clean message thread showing only what the user typed and what Claude said in plain text.
- Live visibility into what Claude is doing while it works, without duplicating it when done.
- Conversation selector that doesn't eat vertical space.
- No terminal rendered in the browser; auth flow still surfaced as a banner.

## Out of Scope

- API key / non-OAuth auth (deferred — no key available yet).
- Conversation search or filtering.
- Markdown rendering in message bubbles (plain text is sufficient for now).

---

## Layout

`ForgePageClient` left pane collapses into a single column:

```
┌─────────────────────────────────────────┐
│ [Dropdown ▾] [+ New]  ● Connected  End  │  ← compact header (shrink-0)
├─────────────────────────────────────────┤
│ 🔑 Auth required: https://claude.ai/…  ✕│  ← auth banner (shrink-0, conditional)
├─────────────────────────────────────────┤
│                                         │
│  You: List all the API routes           │
│                                         │
│  ⚙ Read(app/api/forges/route.ts)        │  ← tool feed (historical, frozen)
│  ⚙ Read(app/api/forges/[id]/route.ts)   │
│  ✓ 8 files read                         │
│                                         │
│  Claude: Here are the routes: …         │
│                                         │
│  You: Add a /health endpoint            │
│                                         │
│  ⚙ Write(app/api/health/route.ts) …▌   │  ← live tool feed (animating)
│                                         │
│                                         │  ← (flex-1, scrollable)
├─────────────────────────────────────────┤
│  [textarea — grows up to ~6 lines]      │  ← input area (shrink-0)
│  Shift+↵ newline          [Send ↵]      │
└─────────────────────────────────────────┘
```

The right pane (`InstancePanel`) is unchanged.

---

## Components

### `ForgePageClient.tsx` — minor change

Remove the `ConversationList` import and its containing `<div>`. Add a compact single-row header inside the left `<aside>`:

```
[ConversationDropdown] [+ New button] [status dot] [End button]
```

`ConversationDropdown` is a plain `<select>` styled to match the dark theme. Items show `{title} · {date}`. Selected item = active conversation.

### `ConversationList.tsx` — delete

No longer used. The dropdown in the header replaces it.

### `ConversationList.test.tsx` — delete

Tests for the deleted component.

### `ChatPanel.tsx` — major rework

**Remove entirely:**
- All xterm imports (`Terminal`, `FitAddon`, `WebLinksAddon`, `@xterm/xterm/css/xterm.css`)
- `hostRef`, `ResizeObserver`, wheel capture listener, `sessionRef`, terminal `useEffect`
- The xterm host `<div>`

**Keep:**
- `useChatSession` (WebSocket connection — still needed to receive PTY bytes and send input)
- `useConversationMessages` (polling for structured message history)
- Auth banner (unchanged)
- Status label / End session button

**Add:**
- `<MessageHistory>` — scrollable message list (see below)
- `<MessageInput>` — textarea + send/interrupt (see below)

**Working state detection:** Claude is "working" when the live tool feed has at least one entry and no new assistant message has arrived yet. Concretely: track a `isWorking` boolean that flips to `true` when a tool-name pattern is detected in the PTY stream, and back to `false` when `useConversationMessages` returns a new assistant message (message count increases and last message role is `assistant`).

### `ConversationHistory.tsx` → `MessageHistory.tsx` — rename + filter

Rename to `MessageHistory` (file and component name). Change the content renderer to skip `tool_use` and `tool_result` blocks entirely — only render `type: 'text'` blocks (and plain string content). Between each `(user, assistant)` message pair, render a frozen tool feed for that exchange: scan the `messages` array (from the DB poll) for any `tool_use` entries that sit between the user message and the assistant reply, and render them as a compact dim list above the assistant bubble. These are already in `messages` — they're just filtered out of the main bubble view and re-surfaced as the feed.

Auto-scroll behaviour is unchanged.

### `MessageInput.tsx` — new component

```
Props: {
  onSend: (text: string) => void
  onInterrupt: () => void
  isWorking: boolean  // dims textarea, swaps Send → Interrupt
}
```

- `<textarea>` with `rows={1}`, auto-grows via `scrollHeight` sync on every `onChange` up to a max of ~6 lines (then scrolls internally).
- `onKeyDown`: Enter without Shift → call `onSend(value)` and reset; Shift+Enter → let default newline through.
- When `isWorking` is true: textarea `disabled`, placeholder changes to "Claude is working…", Send button becomes Interrupt (red tint, calls `onInterrupt`).
- `onSend` in `ChatPanel` sends `{ type: 'input', data: text + '\r' }` via `session.send`.
- `onInterrupt` sends `{ type: 'input', data: '\x1b' }` via `session.send` (Escape to PTY).

### `ToolFeed.tsx` — new component

Two modes:

**Live mode** (while Claude is working): subscribes to the PTY stream via `session.onData`. On each chunk, strips ANSI codes and extracts lines matching Claude Code's tool output pattern: lines containing `⚙`, `✦`, `Read(`, `Write(`, `Bash(`, `Edit(`, etc. Appends extracted tool names to a local list displayed below the last user message. Shows a blinking cursor on the last entry.

**Frozen mode** (after Claude replies): the feed stops updating and stays visible as a collapsed summary above the Claude reply bubble. Displays each tool call as a small dim line. The summary can be toggled open/closed (collapsed by default after reply lands).

Tool pattern detection reuses the same ANSI-strip + regex technique already in place for auth URL detection.

---

## Data Flow

```
PTY stream (WebSocket)
  │
  ├─→ Auth URL detection (existing) → banner state
  │
  └─→ ToolFeed.tsx (live mode)
        │
        └─ freezes when useConversationMessages returns new assistant message

useConversationMessages (2s poll → DB)
  │
  └─→ MessageHistory (renders text-only bubbles + frozen tool feeds)

MessageInput
  │
  ├─→ session.send(text + '\r')    — user message
  └─→ session.send('\x1b')         — interrupt
```

---

## Error Handling

- WS disconnects: existing `status` / `errorMessage` display in header, input disabled when not `open`.
- Empty tool feed: if no tool lines detected before the assistant reply, the feed area simply doesn't render (no empty gap).
- Very long tool lists: capped at 20 visible lines in live mode; remainder scrollable. Frozen summary always shows collapsed (toggle to expand).

---

## Testing

- `ChatPanel.test.tsx`: update mocks to remove xterm. Add test that `onData` firing with a tool-pattern line causes the tool feed to show that line.
- `MessageInput.test.tsx`: new. Tests send on Enter, newline on Shift+Enter, disabled state, interrupt button visibility.
- `ToolFeed.test.tsx`: new. Tests pattern extraction from PTY chunks, freeze on new assistant message.
- `MessageHistory.test.tsx`: new (renamed from `ConversationHistory`). Tests that `tool_use` blocks are not rendered, that `text` blocks are.
- Playwright `auth-banner.spec.ts`: existing test passes unchanged (banner still works the same way).
