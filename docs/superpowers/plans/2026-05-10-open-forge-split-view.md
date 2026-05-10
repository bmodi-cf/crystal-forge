# Open Forge Split View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/forges/[id]` route with a split-pane interface — left = embedded Claude Code session (xterm.js + WebSocket-backed PTY), right = iframe of the running forge — and persist every Claude session into the harness's `Conversation`/`Message` tables for reproducibility. Implements `docs/superpowers/specs/2026-05-10-open-forge-split-view-design.md`.

**Architecture:** A new prisma migration adds `claude_session_id` and converts `Message.content` to jsonb. A WebSocket server (separate port) runs alongside Next via `instrumentation.ts`, gated by short-lived HMAC tickets issued from a REST endpoint. The server spawns `claude` via `node-pty` with `cwd = forgeClonePath(slug)` and pipes bytes bidirectionally with the browser's `xterm.js`. In parallel, a transcript watcher tails Claude Code's session JSONL file and persists each event into the DB.

**Tech Stack:** Next 16 (App Router) · React 19 · TypeScript strict · Prisma 7 · Vitest (jsdom + node) · Playwright · `ws` · `node-pty` · `@xterm/xterm` + `@xterm/addon-fit` · Node stdlib (`fs`, `crypto`, `child_process`).

---

## File Structure

| Path | Purpose |
|---|---|
| `prisma/schema.prisma` | Add `Conversation.claudeSessionId String?`, change `Message.content` to `Json` |
| `prisma/migrations/<ts>_add_claude_session_and_jsonb_message_content/migration.sql` | Generated migration |
| `lib/services/conversations.ts` (+ `.test.ts`) | list / create / get / appendMessage / setClaudeSessionId / maybeBackfillTitle |
| `lib/auth/ws-ticket.ts` (+ `.test.ts`) | HMAC sign/verify of `{conversationId, userId, exp}` |
| `lib/runtime/claude-credentials.ts` | `claudeCredentialsEnv()` — single seam for future per-user credentials |
| `lib/runtime/pty-session.ts` (+ `.test.ts`) | `spawnClaudeSession()` wrapper around `node-pty` |
| `lib/runtime/transcript-watcher.ts` (+ `.test.ts`) | Tail Claude Code's session JSONL, persist each line as a `Message` |
| `lib/runtime/ws-server.ts` (+ `.test.ts`) | `startWsServer()` — listens on `CRYSTAL_FORGE_WS_PORT`, validates ticket, owns one PTY per conversation |
| `app/api/forges/[id]/conversations/route.ts` | GET (list), POST (create) |
| `app/api/forges/[id]/conversations/[conversationId]/route.ts` | GET (full history) |
| `app/api/forges/[id]/conversations/[conversationId]/connect/route.ts` | POST → `{ wsUrl, token, conversationId }` |
| `app/(app)/forges/[id]/page.tsx` | RSC: fetch + render shell |
| `app/(app)/forges/[id]/ForgePageClient.tsx` (+ `.test.tsx`) | Split layout, splitter, owns active conversation |
| `app/(app)/forges/[id]/ConversationList.tsx` (+ `.test.tsx`) | List + New button |
| `app/(app)/forges/[id]/ChatPanel.tsx` (+ `.test.tsx`) | xterm.js + WS client |
| `app/(app)/forges/[id]/InstancePanel.tsx` | Iframe / status card |
| `app/(app)/forges/[id]/useChatSession.ts` | Connect/disconnect/reconnect logic |
| `instrumentation.ts` | Modify — also start WS server |
| `lib/env.ts` | Modify — `CRYSTAL_FORGE_WS_PORT`, `CRYSTAL_FORGE_WS_SECRET` |
| `app/(app)/dashboard/ForgeCard.tsx` | Modify — wrap card body in `<Link>` to `/forges/[id]` |
| `package.json`, `pnpm-lock.yaml` | Modify — add `ws`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, types; add `node-pty` to `pnpm.onlyBuiltDependencies` |
| `tests/e2e/forge-open.spec.ts` | E2E happy path |
| `tests/e2e/fixtures/claude-stub.js` | Deterministic `claude` replacement for CI |

---

## Task 1: Schema migration — `claudeSessionId` + jsonb message content

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_claude_session_and_jsonb_message_content/migration.sql`

- [ ] **Step 1: Update `prisma/schema.prisma`**

In the existing `Conversation` model, after the `title` line, add:

```prisma
  claudeSessionId String?  @map("claude_session_id") @db.Uuid
```

In the existing `Message` model, change:

```prisma
  content        String
```

…to:

```prisma
  content        Json
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
pnpm prisma migrate dev --name add_claude_session_and_jsonb_message_content --create-only
```

Expected: a new directory under `prisma/migrations/` is created with `migration.sql`. It will use `ALTER COLUMN content TYPE JSONB USING content::jsonb` by default — that fails for plain strings. We replace with a wrap.

- [ ] **Step 3: Edit the generated `migration.sql` to wrap existing rows**

Replace the auto-generated `ALTER COLUMN content` line with:

```sql
ALTER TABLE "messages"
  ALTER COLUMN "content" TYPE JSONB
  USING jsonb_build_array(jsonb_build_object('type', 'text', 'text', "content"));
```

The full migration should look like:

```sql
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "claude_session_id" UUID;

-- AlterTable
ALTER TABLE "messages"
  ALTER COLUMN "content" TYPE JSONB
  USING jsonb_build_array(jsonb_build_object('type', 'text', 'text', "content"));
```

- [ ] **Step 4: Apply the migration**

Run:

```bash
pnpm prisma migrate dev
```

Expected: `Database schema is up to date!` and `Generated Prisma Client`.

- [ ] **Step 5: Verify the column types**

Run:

```bash
docker exec crystal-forge-pg psql -U crystal -d crystal_forge -c "\d messages"
```

Expected: `content` is `jsonb`, `not null`.

```bash
docker exec crystal-forge-pg psql -U crystal -d crystal_forge -c "\d conversations"
```

Expected: `claude_session_id` is `uuid`, nullable.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add claude_session_id + jsonb message content"
```

---

## Task 2: Conversations service

**Files:**
- Create: `lib/services/conversations.ts`
- Test:   `lib/services/conversations.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/services/conversations.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import {
  listConversations, createConversation, getConversation,
  appendMessage, setClaudeSessionId, maybeBackfillTitle,
} from './conversations';
import { ForbiddenError, NotFoundError } from '@/lib/errors';

describe('conversations service', () => {
  it('createConversation requires write access', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const intruder = await makeUser(prisma, { email: 'i@x', name: 'I', groups: [] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      await expect(createConversation(intruder, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
      const conv = await createConversation(tom, forge.id);
      expect(conv.title).toBe('New conversation');
      expect(conv.hasClaudeSessionId).toBe(false);
    });
  });

  it('listConversations is gated by canReadForge and ordered by updatedAt desc', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const reader = await makeUser(prisma, { email: 'r@x', name: 'R', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const a = await createConversation(tom, forge.id);
      await new Promise((r) => setTimeout(r, 5));
      const b = await createConversation(tom, forge.id);
      const list = await listConversations(reader, forge.id);
      expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
    });
  });

  it('getConversation returns full message history', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
      await appendMessage(conv.id, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.messages).toHaveLength(2);
      expect(got.messages[0]?.role).toBe('user');
      expect(got.messages[1]?.role).toBe('assistant');
    });
  });

  it('appendMessage backfills title from first user message', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'Add a quote builder for line items' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title).toBe('Add a quote builder for line items');
    });
  });

  it('appendMessage truncates very long titles to 80 chars', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      const long = 'A'.repeat(200);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: long }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('setClaudeSessionId is idempotent — only first write wins', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      const id1 = '00000000-0000-0000-0000-000000000001';
      const id2 = '00000000-0000-0000-0000-000000000002';
      await setClaudeSessionId(conv.id, id1);
      await setClaudeSessionId(conv.id, id2);
      const got = await getConversation(tom, conv.id);
      expect(got.hasClaudeSessionId).toBe(true);
      // Direct DB peek to confirm id1 stuck.
      const row = await prisma.conversation.findUnique({ where: { id: conv.id } });
      expect(row?.claudeSessionId).toBe(id1);
    });
  });

  it('getConversation throws NotFound on unknown id', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await expect(getConversation(tom, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('maybeBackfillTitle is a no-op when title is already custom', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await prisma.conversation.update({ where: { id: conv.id }, data: { title: 'Custom title' } });
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'should not overwrite' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title).toBe('Custom title');
    });
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/services/conversations.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/services/conversations.ts`**

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canReadForge, canWriteForge } from '@/lib/acl';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import type { SessionUser } from './types';

const TITLE_MAX = 80;
const DEFAULT_TITLE = 'New conversation';

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
    content: unknown;
    createdAt: string;
  }>;
};

const conversationInclude = {
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    forgeId: row.forgeId,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    title: row.title,
    hasClaudeSessionId: row.claudeSessionId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadForgeForAcl(forgeId: string) {
  const row = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!row) throw new NotFoundError('forge', forgeId);
  return {
    id: row.id,
    createdById: row.createdById,
    groups: row.groups.map((fg) => fg.group.name),
  };
}

export async function listConversations(currentUser: SessionUser, forgeId: string): Promise<ConversationDto[]> {
  const acl = await loadForgeForAcl(forgeId);
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  const rows = await prisma.conversation.findMany({
    where: { forgeId, createdById: currentUser.id },
    include: conversationInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toDto);
}

export async function createConversation(currentUser: SessionUser, forgeId: string): Promise<ConversationDto> {
  const acl = await loadForgeForAcl(forgeId);
  if (!canWriteForge(currentUser, acl)) throw new ForbiddenError(`Cannot create conversation on forge ${forgeId}`);
  const row = await prisma.conversation.create({
    data: { forgeId, createdById: currentUser.id, title: DEFAULT_TITLE },
    include: conversationInclude,
  });
  return toDto(row);
}

export async function getConversation(currentUser: SessionUser, conversationId: string): Promise<ConversationWithMessagesDto> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { ...conversationInclude, messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!row) throw new NotFoundError('conversation', conversationId);
  const acl = await loadForgeForAcl(row.forgeId);
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read conversation ${conversationId}`);
  return {
    ...toDto(row),
    messages: row.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function appendMessage(
  conversationId: string,
  payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date },
): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId,
      role: payload.role,
      content: payload.content as Prisma.InputJsonValue,
      ...(payload.createdAt ? { createdAt: payload.createdAt } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
  if (payload.role === 'user') await maybeBackfillTitle(conversationId);
}

export async function setClaudeSessionId(conversationId: string, sessionId: string): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId, claudeSessionId: null },
    data: { claudeSessionId: sessionId },
  }).catch(() => { /* already set — idempotent */ });
}

export async function maybeBackfillTitle(conversationId: string): Promise<void> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 1, where: { role: 'user' } } },
  });
  if (!row || row.title !== DEFAULT_TITLE) return;
  const first = row.messages[0];
  if (!first) return;
  const text = flattenContentText(first.content);
  if (!text) return;
  const truncated = text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text;
  await prisma.conversation.update({ where: { id: conversationId }, data: { title: truncated } });
}

function flattenContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join(' ').trim();
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/services/conversations.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/services/conversations.ts lib/services/conversations.test.ts
git commit -m "feat(services): conversations service with ACL + auto-title backfill"
```

---

## Task 3: WebSocket ticket — HMAC sign/verify

**Files:**
- Create: `lib/auth/ws-ticket.ts`
- Test:   `lib/auth/ws-ticket.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/auth/ws-ticket.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { signTicket, verifyTicket } from './ws-ticket';

const SECRET = 'a'.repeat(32);

describe('ws-ticket', () => {
  it('signs and verifies a ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, SECRET)).toEqual(payload);
  });

  it('rejects an expired ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() - 1 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, SECRET)).toBeNull();
  });

  it('rejects a tampered ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    // Flip a payload character.
    const [body, sig] = tok.split('.');
    const tampered = body!.slice(0, -1) + (body!.slice(-1) === 'A' ? 'B' : 'A') + '.' + sig!;
    expect(verifyTicket(tampered, SECRET)).toBeNull();
  });

  it('rejects a wrong-secret ticket', () => {
    const payload = { conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 };
    const tok = signTicket(payload, SECRET);
    expect(verifyTicket(tok, 'b'.repeat(32))).toBeNull();
  });

  it('rejects a malformed ticket', () => {
    expect(verifyTicket('garbage', SECRET)).toBeNull();
    expect(verifyTicket('only-one-part', SECRET)).toBeNull();
    expect(verifyTicket('two.parts.three', SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/auth/ws-ticket.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/auth/ws-ticket.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TicketPayload = {
  conversationId: string;
  userId: string;
  exp: number; // ms epoch
};

export function signTicket(payload: TicketPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyTicket(token: string, secret: string): TicketPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload;
  } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  if (typeof payload.conversationId !== 'string' || typeof payload.userId !== 'string') return null;
  return payload;
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/auth/ws-ticket.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/ws-ticket.ts lib/auth/ws-ticket.test.ts
git commit -m "feat(auth): HMAC ws-ticket sign/verify (60s TTL, base64url)"
```

---

## Task 4: Env vars + dependencies

**Files:**
- Modify: `lib/env.ts`
- Modify: `package.json`

- [ ] **Step 1: Add env vars**

In `lib/env.ts` `baseSchema`, after `CRYSTAL_FORGE_HOME`, add:

```ts
  // Runtime WebSocket server (for the embedded Claude Code session).
  CRYSTAL_FORGE_WS_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  CRYSTAL_FORGE_WS_SECRET: z.string().optional(),
```

In the `superRefine` block, add a production-only required check:

```ts
  if (val.NODE_ENV === 'production') {
    const sec = val.CRYSTAL_FORGE_WS_SECRET;
    if (!sec || sec.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['CRYSTAL_FORGE_WS_SECRET'],
        message: 'CRYSTAL_FORGE_WS_SECRET must be at least 16 chars in production',
      });
    }
  }
```

In the same block, generate a dev fallback so the dev / test paths don't need `.env` configuration:

```ts
  // After validation succeeds, ensure a usable secret in non-production.
```

(We resolve this in the export below.)

Replace the bottom of `lib/env.ts`:

```ts
export const env = parsed.data;
```

…with:

```ts
const data = parsed.data;
if (!data.CRYSTAL_FORGE_WS_SECRET) {
  data.CRYSTAL_FORGE_WS_SECRET = 'dev-only-' + 'x'.repeat(16);
}
export const env = data as typeof data & { CRYSTAL_FORGE_WS_SECRET: string };
```

- [ ] **Step 2: Add dependencies**

Edit `package.json`:

In `dependencies`, add (alphabetical):

```json
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.6.0",
    "node-pty": "^1.0.0",
    "ws": "^8.18.0",
```

In `devDependencies`, add:

```json
    "@types/ws": "^8.5.13",
```

In the `pnpm.onlyBuiltDependencies` array, add `"node-pty"`:

```json
  "pnpm": {
    "onlyBuiltDependencies": [
      "@prisma/engines",
      "prisma",
      "esbuild",
      "node-pty"
    ]
  },
```

- [ ] **Step 3: Install**

Run:

```bash
pnpm install
```

Expected: `Done` with `+ 4 packages` (or similar). Watch for `node-pty` build success — it compiles a native addon.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts package.json pnpm-lock.yaml
git commit -m "chore(deps): add ws + node-pty + xterm; env vars for runtime WS server"
```

---

## Task 5: PTY session helper + Claude credentials seam

**Files:**
- Create: `lib/runtime/claude-credentials.ts`
- Create: `lib/runtime/pty-session.ts`
- Test:   `lib/runtime/pty-session.test.ts`

- [ ] **Step 1: Create `lib/runtime/claude-credentials.ts`**

```ts
/**
 * Single seam for the credentials a spawned `claude` subprocess sees.
 *
 * Today: returns an empty env override, so the child inherits the harness
 * operator's `~/.claude/` (i.e. `process.env.HOME`).
 *
 * Future: a per-user variant will return `{ HOME: '/path/to/user-claude-home' }`
 * or set `CLAUDE_CONFIG_DIR` directly. Callers must NOT read these env vars
 * by other means — this is the only seam.
 */
export function claudeCredentialsEnv(): Record<string, string> {
  return {};
}
```

- [ ] **Step 2: Write the failing tests**

`lib/runtime/pty-session.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawnClaudeSession } from './pty-session';

const sessions: Array<{ kill: () => void }> = [];

afterEach(() => {
  while (sessions.length) sessions.pop()?.kill();
});

describe('spawnClaudeSession', () => {
  it('spawns a child shell, streams stdout, and exits cleanly on kill', async () => {
    // Use bash as a stand-in for `claude` so the test doesn't require auth.
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'echo hello-from-pty; sleep 5'],
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);
    expect(typeof session.pid).toBe('number');

    const buf: string[] = [];
    session.onData((chunk) => buf.push(chunk));

    // Wait briefly for echo output.
    await new Promise((r) => setTimeout(r, 200));
    expect(buf.join('')).toContain('hello-from-pty');

    const exitPromise = new Promise<number>((resolve) => session.onExit((code) => resolve(code)));
    session.kill();
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('exit timeout')), 2000)),
    ]);
    expect(typeof exitCode).toBe('number');
  });

  it('forwards write() to the child stdin', async () => {
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'cat'], // echoes whatever we write
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);

    const buf: string[] = [];
    session.onData((chunk) => buf.push(chunk));

    session.write('ping\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(buf.join('')).toContain('ping');
  });

  it('resize() does not throw', async () => {
    const session = spawnClaudeSession({
      command: 'bash',
      args: ['-c', 'sleep 2'],
      cwd: process.cwd(),
      cols: 80, rows: 24,
    });
    sessions.push(session);
    expect(() => session.resize(120, 30)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run — should fail**

Run: `pnpm test lib/runtime/pty-session.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `lib/runtime/pty-session.ts`**

```ts
import { spawn as spawnPty, type IPty } from 'node-pty';
import { claudeCredentialsEnv } from './claude-credentials';

export type SpawnOpts = {
  /** Defaults to 'claude' — overridable for tests. */
  command?: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Extra env overrides, merged on top of process.env + claudeCredentialsEnv(). */
  env?: Record<string, string>;
};

export type Session = {
  pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(signal?: string): void;
};

export function spawnClaudeSession(opts: SpawnOpts): Session {
  const command = opts.command ?? 'claude';
  const args = opts.args ?? [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  Object.assign(env, claudeCredentialsEnv(), opts.env ?? {});

  const child: IPty = spawnPty(command, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env,
  });

  return {
    pid: child.pid,
    write: (data) => child.write(typeof data === 'string' ? data : data.toString('utf8')),
    resize: (cols, rows) => child.resize(cols, rows),
    onData: (handler) => { child.onData(handler); },
    onExit: (handler) => { child.onExit(({ exitCode }) => handler(exitCode)); },
    kill: (signal) => { try { child.kill(signal); } catch { /* already dead */ } },
  };
}
```

- [ ] **Step 5: Run — should pass**

Run: `pnpm test lib/runtime/pty-session.test.ts`
Expected: PASS (3 tests). Total time ~1–2s.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/claude-credentials.ts lib/runtime/pty-session.ts lib/runtime/pty-session.test.ts
git commit -m "feat(runtime): pty-session wrapper around node-pty + claude-credentials seam"
```

---

## Task 6: Transcript watcher

**Files:**
- Create: `lib/runtime/transcript-watcher.ts`
- Test:   `lib/runtime/transcript-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/transcript-watcher.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startTranscriptWatcher, encodedCwd, parseTranscriptLine,
} from './transcript-watcher';

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tw-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('encodedCwd', () => {
  it('replaces / with - for the project dir name', () => {
    expect(encodedCwd('/home/bmodi/.crystal-forge/clones/marketing-frufru'))
      .toBe('-home-bmodi--crystal-forge-clones-marketing-frufru');
  });
});

describe('parseTranscriptLine', () => {
  it('parses a user line with text content', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: 'sid-1' });
    expect(parseTranscriptLine(line)).toEqual({
      sessionId: 'sid-1',
      message: { role: 'user', content: 'hi' },
    });
  });

  it('parses an assistant line with structured content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      sessionId: 'sid-2',
    });
    expect(parseTranscriptLine(line)).toEqual({
      sessionId: 'sid-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseTranscriptLine('garbage')).toBeNull();
    expect(parseTranscriptLine('{}')).toBeNull();
  });
});

describe('startTranscriptWatcher', () => {
  it('claims the JSONL file with mtime >= spawn time and persists each line', async () => {
    const cloneDir = '/home/x/clone';
    const projectDir = path.join(tmp, '.claude', 'projects', encodedCwd(cloneDir));
    fs.mkdirSync(projectDir, { recursive: true });

    const append = vi.fn();
    const setSession = vi.fn();
    const watcher = startTranscriptWatcher('conv-1', cloneDir, {
      appendMessage: append,
      setClaudeSessionId: setSession,
      pollIntervalMs: 30,
      claimWindowMs: 1000,
    });

    // Wait briefly, then create the JSONL with a session header line.
    await new Promise((r) => setTimeout(r, 60));
    const file = path.join(projectDir, 'sid-A.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      sessionId: 'sid-A',
    }) + '\n');

    // Wait for watcher to pick it up.
    await new Promise((r) => setTimeout(r, 200));

    expect(setSession).toHaveBeenCalledWith('conv-1', 'sid-A');
    expect(append).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }));

    // Append another line and verify it lands.
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      sessionId: 'sid-A',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(append).toHaveBeenCalledTimes(2);

    watcher.stop();
  });

  it('ignores stale JSONL files whose mtime is older than spawn time', async () => {
    const cloneDir = '/home/x/clone';
    const projectDir = path.join(tmp, '.claude', 'projects', encodedCwd(cloneDir));
    fs.mkdirSync(projectDir, { recursive: true });
    const stale = path.join(projectDir, 'sid-stale.jsonl');
    fs.writeFileSync(stale, JSON.stringify({
      type: 'user', message: { role: 'user', content: 'old' }, sessionId: 'sid-stale',
    }) + '\n');
    // Backdate.
    const past = Date.now() / 1000 - 60;
    fs.utimesSync(stale, past, past);

    const append = vi.fn();
    const watcher = startTranscriptWatcher('conv-2', cloneDir, {
      appendMessage: append,
      setClaudeSessionId: vi.fn(),
      pollIntervalMs: 30,
      claimWindowMs: 200,
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(append).not.toHaveBeenCalled();
    watcher.stop();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/runtime/transcript-watcher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/transcript-watcher.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AppendMessageFn = (
  conversationId: string,
  payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date },
) => Promise<void>;

export type SetClaudeSessionIdFn = (conversationId: string, sessionId: string) => Promise<void>;

export type WatcherDeps = {
  appendMessage: AppendMessageFn;
  setClaudeSessionId: SetClaudeSessionIdFn;
  /** Defaults: claim 30s, poll 250ms. Tests override to be brisk. */
  claimWindowMs?: number;
  pollIntervalMs?: number;
};

/** Project-dir naming used by Claude Code: cwd with `/` → `-`. */
export function encodedCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function parseTranscriptLine(line: string): { sessionId: string; message: { role: 'user' | 'assistant'; content: unknown } } | null {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { sessionId?: unknown; message?: unknown };
  if (typeof o.sessionId !== 'string') return null;
  const msg = o.message as { role?: unknown; content?: unknown } | undefined;
  if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;
  return { sessionId: o.sessionId, message: { role: msg.role, content: msg.content } };
}

type TailHandle = { stop: () => void };

function tailJsonl(file: string, onLine: (line: string) => void, pollIntervalMs: number): TailHandle {
  let offset = 0;
  let buffer = '';
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  function poll() {
    if (stopped) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size > offset) {
        const fd = fs.openSync(file, 'r');
        try {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, offset);
          offset = stat.size;
          buffer += buf.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) onLine(line);
          }
        } finally { fs.closeSync(fd); }
      }
    } catch { /* file gone, etc. */ }
    if (!stopped) timer = setTimeout(poll, pollIntervalMs);
  }
  timer = setTimeout(poll, pollIntervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startTranscriptWatcher(
  conversationId: string,
  cloneDir: string,
  deps: WatcherDeps,
): { stop: () => void } {
  const claimWindowMs = deps.claimWindowMs ?? 30_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd(cloneDir));
  const t0 = Date.now();
  let tail: TailHandle | null = null;
  let stopped = false;
  let claimTimer: NodeJS.Timeout | null = null;

  function tryClaim() {
    if (stopped || tail) return;
    let bestFile: string | null = null;
    let bestMtime = -1;
    try {
      const entries = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      for (const f of entries) {
        const stat = fs.statSync(path.join(projectDir, f));
        const mtimeMs = stat.mtimeMs;
        if (mtimeMs >= t0 - 50 && mtimeMs > bestMtime) {
          bestMtime = mtimeMs;
          bestFile = path.join(projectDir, f);
        }
      }
    } catch { /* dir not yet created */ }

    if (bestFile) {
      let sessionRecorded = false;
      tail = tailJsonl(bestFile, (line) => {
        const parsed = parseTranscriptLine(line);
        if (!parsed) return;
        if (!sessionRecorded) {
          sessionRecorded = true;
          void deps.setClaudeSessionId(conversationId, parsed.sessionId).catch(() => {});
        }
        void deps.appendMessage(conversationId, {
          role: parsed.message.role,
          content: parsed.message.content,
        }).catch(() => {});
      }, pollIntervalMs);
      return;
    }
    if (Date.now() - t0 > claimWindowMs) return; // give up silently
    claimTimer = setTimeout(tryClaim, pollIntervalMs);
  }
  claimTimer = setTimeout(tryClaim, pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      if (claimTimer) clearTimeout(claimTimer);
      tail?.stop();
    },
  };
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/runtime/transcript-watcher.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/transcript-watcher.ts lib/runtime/transcript-watcher.test.ts
git commit -m "feat(runtime): transcript watcher tails Claude Code JSONL into Conversation/Message"
```

---

## Task 7: WebSocket server

**Files:**
- Create: `lib/runtime/ws-server.ts`
- Test:   `lib/runtime/ws-server.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/runtime/ws-server.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startWsServer } from './ws-server';
import { signTicket } from '@/lib/auth/ws-ticket';

const SECRET = 'a'.repeat(32);

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

async function startServer(overrides: Partial<Parameters<typeof startWsServer>[0]> = {}) {
  const fakePty = {
    spawn: vi.fn(() => ({
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
    })),
  };
  const fakeWatcher = {
    start: vi.fn(() => ({ stop: vi.fn() })),
  };
  const server = await startWsServer({
    port: 0, // OS-assigned
    secret: SECRET,
    spawnPty: fakePty.spawn,
    startWatcher: fakeWatcher.start,
    forgeClonePath: () => '/tmp/clone',
    loadConversation: async (id: string) => ({ id, slug: 'aquaflow-designer', claudeSessionId: null }),
    ...overrides,
  });
  servers.push(server);
  return { server, fakePty, fakeWatcher };
}

describe('ws-server', () => {
  it('accepts a valid ticket and spawns a PTY', async () => {
    const { server, fakePty, fakeWatcher } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('open timeout')), 2000);
    });
    expect(fakePty.spawn).toHaveBeenCalledTimes(1);
    expect(fakeWatcher.start).toHaveBeenCalledWith('c1', '/tmp/clone', expect.anything());
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('rejects an expired ticket with close code 4401', async () => {
    const { server } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() - 1 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', () => resolve(-1));
      setTimeout(() => resolve(-2), 2000);
    });
    expect(code).toBe(4401);
  });

  it('rejects a duplicate connection for the same conversation with close code 4409', async () => {
    const { server } = await startServer();
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const a = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve) => a.once('open', resolve));
    const b = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    const code = await new Promise<number>((resolve) => {
      b.once('close', (c) => resolve(c));
    });
    expect(code).toBe(4409);
    a.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('forwards client messages to the PTY', async () => {
    let captured: ((s: string) => void) | null = null;
    const fakeWrite = vi.fn();
    const { server } = await startServer({
      spawnPty: () => ({
        pid: 1, write: fakeWrite, resize: vi.fn(),
        onData: (h) => { captured = h; },
        onExit: vi.fn(), kill: vi.fn(),
      }),
    } as never);
    const tok = signTicket({ conversationId: 'c1', userId: 'u1', exp: Date.now() + 60_000 }, SECRET);
    const ws = new WebSocket(`ws://localhost:${server.port}/?token=${encodeURIComponent(tok)}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeWrite).toHaveBeenCalledWith('hi');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test lib/runtime/ws-server.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/runtime/ws-server.ts`**

```ts
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import { startTranscriptWatcher, type WatcherDeps } from './transcript-watcher';
import { appendMessage as defaultAppend, setClaudeSessionId as defaultSet } from '@/lib/services/conversations';
import { forgeClonePath as defaultForgeClonePath } from './paths';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { slugifyForgeName } from '@/lib/github/slug';

type ConversationLite = { id: string; slug: string; claudeSessionId: string | null };

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, cloneDir: string, deps: WatcherDeps) => { stop: () => void };
  forgeClonePath?: (slug: string) => string;
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
};

type ActiveSession = { ws: WebSocket; pty: Session; watcher: { stop: () => void } };

export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, dir, deps) => startTranscriptWatcher(cid, dir, deps));
  const forgeClonePath = opts.forgeClonePath ?? defaultForgeClonePath;
  const loadConversation = opts.loadConversation ?? (async (id) => {
    const row = await defaultPrisma.conversation.findUnique({
      where: { id },
      include: { forge: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      slug: slugifyForgeName(row.forge.name),
      claudeSessionId: row.claudeSessionId,
    };
  });

  const sessions = new Map<string, ActiveSession>();
  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const token = url.searchParams.get('token') ?? '';
    const payload = verifyTicket(token, opts.secret);
    if (!payload) { ws.close(4401, 'Invalid or expired ticket'); return; }
    if (sessions.has(payload.conversationId)) { ws.close(4409, 'Conversation already active'); return; }
    const conv = await loadConversation(payload.conversationId);
    if (!conv) { ws.close(4404, 'Conversation not found'); return; }

    const cwd = forgeClonePath(conv.slug);
    const pty = spawnPty({
      cwd, cols: 80, rows: 24,
      ...(conv.claudeSessionId ? { args: ['--resume', conv.claudeSessionId] } : {}),
    });
    const watcher = startWatcher(conv.id, cwd, {
      appendMessage: defaultAppend,
      setClaudeSessionId: defaultSet,
    });
    const active: ActiveSession = { ws, pty, watcher };
    sessions.set(conv.id, active);

    pty.onData((chunk) => {
      try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ }
    });
    pty.onExit((code) => {
      try { ws.close(4000, `pty exit ${code}`); } catch { /* already closed */ }
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { pty.write(raw as Buffer); return; }
      const text = raw.toString('utf8');
      try {
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === 'input' && typeof (msg as { data?: unknown }).data === 'string') {
          pty.write((msg as { data: string }).data); return;
        }
        if (msg.type === 'resize') {
          const m = msg as { cols?: number; rows?: number };
          if (typeof m.cols === 'number' && typeof m.rows === 'number') pty.resize(m.cols, m.rows);
          return;
        }
      } catch { /* not JSON — fall through to raw write */ }
      pty.write(text);
    });
    ws.on('close', () => {
      pty.kill();
      watcher.stop();
      sessions.delete(conv.id);
    });
  });

  return new Promise<{ stop: () => void; port: number }>((resolve) => {
    http.listen(opts.port, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        stop: () => {
          for (const s of sessions.values()) {
            try { s.ws.close(); } catch { /* noop */ }
            s.pty.kill(); s.watcher.stop();
          }
          sessions.clear();
          wss.close();
          http.close();
        },
      });
    });
  });
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test lib/runtime/ws-server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ws-server.ts lib/runtime/ws-server.test.ts
git commit -m "feat(runtime): WS server gating PTY sessions by HMAC ticket (1 PTY per conversation)"
```

---

## Task 8: Boot the WS server from `instrumentation.ts`

**Files:**
- Modify: `instrumentation.ts`

- [ ] **Step 1: Update `instrumentation.ts`**

Replace the existing body with:

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV === 'test') return;
  const { bootCleanup, startLivenessLoop } = await import('./lib/runtime/runner');
  const { startWsServer } = await import('./lib/runtime/ws-server');
  const { env } = await import('./lib/env');
  try { await bootCleanup(); }
  catch (err) { console.error('[instrumentation] bootCleanup failed', err); }
  startLivenessLoop();
  console.info('[instrumentation] runtime liveness loop started');
  try {
    const ws = await startWsServer({ port: env.CRYSTAL_FORGE_WS_PORT, secret: env.CRYSTAL_FORGE_WS_SECRET });
    console.info(`[instrumentation] runtime WS server listening on ${ws.port}`);
  } catch (err) {
    console.error('[instrumentation] WS server failed to start', err);
  }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add instrumentation.ts
git commit -m "feat(runtime): start WS server from instrumentation.ts"
```

---

## Task 9: REST routes — conversations CRUD + connect ticket

**Files:**
- Create: `app/api/forges/[id]/conversations/route.ts`
- Create: `app/api/forges/[id]/conversations/[conversationId]/route.ts`
- Create: `app/api/forges/[id]/conversations/[conversationId]/connect/route.ts`

- [ ] **Step 1: Create the GET/POST handler**

`app/api/forges/[id]/conversations/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { listConversations, createConversation } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const conversations = await listConversations(session.user, id);
    return NextResponse.json({ conversations });
  } catch (err) { return respondToServiceError(err); }
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const conversation = await createConversation(session.user, id);
    return NextResponse.json({ conversation });
  } catch (err) { return respondToServiceError(err); }
}
```

- [ ] **Step 2: Create the per-conversation history route**

`app/api/forges/[id]/conversations/[conversationId]/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getConversation } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { conversationId } = await ctx.params;
  try {
    const conversation = await getConversation(session.user, conversationId);
    return NextResponse.json({ conversation });
  } catch (err) { return respondToServiceError(err); }
}
```

- [ ] **Step 3: Create the connect-ticket route**

`app/api/forges/[id]/conversations/[conversationId]/connect/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { signTicket } from '@/lib/auth/ws-ticket';
import { env } from '@/lib/env';
import { canWriteForge } from '@/lib/acl';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { respondToServiceError } from '@/lib/http';

const TICKET_TTL_MS = 60_000;

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]/connect'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: forgeId, conversationId } = await ctx.params;
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { forge: { include: { groups: { include: { group: true } } } } },
    });
    if (!conv || conv.forgeId !== forgeId) throw new NotFoundError('conversation', conversationId);
    const acl = {
      id: conv.forge.id,
      createdById: conv.forge.createdById,
      groups: conv.forge.groups.map((fg) => fg.group.name),
    };
    if (!canWriteForge(session.user, acl)) {
      throw new ForbiddenError(`Cannot connect to conversation ${conversationId}`);
    }
    const token = signTicket(
      { conversationId, userId: session.user.id, exp: Date.now() + TICKET_TTL_MS },
      env.CRYSTAL_FORGE_WS_SECRET,
    );
    const wsUrl = `ws://localhost:${env.CRYSTAL_FORGE_WS_PORT}/`;
    return NextResponse.json({ wsUrl, token, conversationId });
  } catch (err) { return respondToServiceError(err); }
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/forges/[id]/conversations
git commit -m "feat(api): conversations REST + connect-ticket route"
```

---

## Task 10: ChatPanel component (xterm.js + WebSocket client)

**Files:**
- Create: `app/(app)/forges/[id]/useChatSession.ts`
- Create: `app/(app)/forges/[id]/ChatPanel.tsx`
- Test:   `app/(app)/forges/[id]/ChatPanel.test.tsx`

- [ ] **Step 1: Implement `useChatSession`**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

export type ChatStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type ChatSession = {
  status: ChatStatus;
  errorMessage: string | null;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Subscribe to incoming server bytes. */
  onData: (handler: (chunk: string) => void) => () => void;
};

export function useChatSession(forgeId: string, conversationId: string | null): ChatSession {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(chunk: string) => void>>(new Set());

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setStatus('connecting');
    setErrorMessage(null);
    (async () => {
      try {
        const res = await fetch(`/api/forges/${forgeId}/conversations/${conversationId}/connect`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `connect failed (${res.status})`);
        const body = (await res.json()) as { wsUrl: string; token: string };
        if (cancelled) return;
        const ws = new WebSocket(`${body.wsUrl}?token=${encodeURIComponent(body.token)}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus('open');
        ws.onmessage = (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : '';
          handlersRef.current.forEach((h) => h(text));
        };
        ws.onclose = (ev) => {
          if (ev.code === 4401) setErrorMessage('Authorization expired');
          else if (ev.code === 4409) setErrorMessage('Conversation already active in another tab');
          else if (ev.code === 4404) setErrorMessage('Conversation not found');
          setStatus('closed');
        };
        ws.onerror = () => { setStatus('error'); setErrorMessage('WebSocket error'); };
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Failed to connect');
        }
      }
    })();
    return () => {
      cancelled = true;
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [forgeId, conversationId]);

  return {
    status,
    errorMessage,
    send: (data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    },
    resize: (cols, rows) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    onData: (handler) => {
      handlersRef.current.add(handler);
      return () => { handlersRef.current.delete(handler); };
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`app/(app)/forges/[id]/ChatPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

vi.mock('./useChatSession', () => ({
  useChatSession: vi.fn(() => ({
    status: 'idle',
    errorMessage: null,
    send: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
  })),
}));

describe('ChatPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an empty state when conversationId is null', () => {
    render(<ChatPanel forgeId="f1" conversationId={null} />);
    expect(screen.getByText(/select or start a conversation/i)).toBeInTheDocument();
  });

  it('mounts a terminal container when a conversation is selected', () => {
    const { container } = render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(container.querySelector('[data-testid="xterm-host"]')).toBeInTheDocument();
  });

  it('shows the connect status', async () => {
    const { useChatSession } = await import('./useChatSession');
    (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 'connecting',
      errorMessage: null,
      send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}),
    });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('shows the error message when status=error', async () => {
    const { useChatSession } = await import('./useChatSession');
    (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 'error',
      errorMessage: 'WebSocket error',
      send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}),
    });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByText(/WebSocket error/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run — should fail**

Run: `pnpm test 'app/(app)/forges/[id]/ChatPanel.test.tsx'`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `ChatPanel.tsx`**

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useChatSession, type ChatStatus } from './useChatSession';

type Props = {
  forgeId: string;
  conversationId: string | null;
};

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
  error: 'Error',
};

export function ChatPanel({ forgeId, conversationId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = useChatSession(forgeId, conversationId);

  useEffect(() => {
    if (!conversationId || !hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0c0e12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    session.resize(term.cols, term.rows);
    const onResize = () => { fit.fit(); session.resize(term.cols, term.rows); };
    window.addEventListener('resize', onResize);
    const dataDispose = term.onData((data) => session.send(data));
    const unsub = session.onData((chunk) => term.write(chunk));
    return () => {
      window.removeEventListener('resize', onResize);
      dataDispose.dispose();
      unsub();
      term.dispose();
    };
  }, [conversationId, session]);

  if (!conversationId) {
    return (
      <div className="grid place-items-center h-full p-6 text-ink-faint text-[12px]">
        Select or start a conversation to begin.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-ink-faint">
        <span>{STATUS_LABEL[session.status]}</span>
        {session.errorMessage ? <span className="text-[#d96868]">{session.errorMessage}</span> : null}
      </div>
      <div data-testid="xterm-host" ref={hostRef} className="flex-1 overflow-hidden bg-[#0c0e12]" />
    </div>
  );
}
```

- [ ] **Step 5: Run — should pass**

Run: `pnpm test 'app/(app)/forges/[id]/ChatPanel.test.tsx'`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/(app)/forges/[id]/ChatPanel.tsx app/(app)/forges/[id]/ChatPanel.test.tsx app/(app)/forges/[id]/useChatSession.ts
git commit -m "feat(forge-page): xterm.js + WebSocket-backed ChatPanel"
```

---

## Task 11: ConversationList component

**Files:**
- Create: `app/(app)/forges/[id]/ConversationList.tsx`
- Test:   `app/(app)/forges/[id]/ConversationList.test.tsx`

- [ ] **Step 1: Write the failing tests**

`app/(app)/forges/[id]/ConversationList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationList } from './ConversationList';

const sample = [
  { id: 'c1', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'Setup auth', hasClaudeSessionId: true,  createdAt: '2026-05-09T12:00:00Z', updatedAt: '2026-05-09T12:00:00Z' },
  { id: 'c2', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'First steps', hasClaudeSessionId: false, createdAt: '2026-05-08T09:00:00Z', updatedAt: '2026-05-08T09:00:00Z' },
];

describe('ConversationList', () => {
  it('renders titles and a New button', () => {
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('Setup auth')).toBeInTheDocument();
    expect(screen.getByText('First steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ new/i })).toBeEnabled();
  });

  it('marks the active conversation', () => {
    render(<ConversationList items={sample} activeId="c1" canWrite onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('Setup auth').closest('button')).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('First steps').closest('button')).toHaveAttribute('data-active', 'false');
  });

  it('disables New when canWrite is false', () => {
    render(<ConversationList items={sample} activeId={null} canWrite={false} onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByRole('button', { name: /\+ new/i })).toBeDisabled();
  });

  it('fires onSelect when a conversation is clicked', async () => {
    const onSelect = vi.fn();
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={onSelect} onCreate={() => {}} />);
    await userEvent.click(screen.getByText('Setup auth'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('fires onCreate when New is clicked', async () => {
    const onCreate = vi.fn();
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={() => {}} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole('button', { name: /\+ new/i }));
    expect(onCreate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test 'app/(app)/forges/[id]/ConversationList.test.tsx'`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `ConversationList.tsx`**

```tsx
'use client';

import type { ConversationDto } from '@/lib/services/conversations';

type Props = {
  items: ConversationDto[];
  activeId: string | null;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

export function ConversationList({ items, activeId, canWrite, onSelect, onCreate }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-wide text-ink-faint">Conversations</h2>
        <button
          type="button"
          onClick={onCreate}
          disabled={!canWrite}
          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-ink-dim hover:bg-panel-3 disabled:opacity-50"
        >
          + New
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              data-active={c.id === activeId ? 'true' : 'false'}
              onClick={() => onSelect(c.id)}
              className="block w-full text-left rounded-md border border-transparent px-2 py-1.5 text-[12px] text-ink-dim hover:bg-panel-2 data-[active=true]:border-border-strong data-[active=true]:bg-panel-2 data-[active=true]:text-ink"
            >
              <div className="truncate">{c.title}</div>
              <div className="font-mono text-[10px] text-ink-faint">
                {new Date(c.updatedAt).toISOString().slice(0, 10)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test 'app/(app)/forges/[id]/ConversationList.test.tsx'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/(app)/forges/[id]/ConversationList.tsx app/(app)/forges/[id]/ConversationList.test.tsx
git commit -m "feat(forge-page): ConversationList component"
```

---

## Task 12: InstancePanel component

**Files:**
- Create: `app/(app)/forges/[id]/InstancePanel.tsx`

- [ ] **Step 1: Implement `InstancePanel.tsx`**

```tsx
'use client';

import { ExternalLink, Play } from 'lucide-react';
import type { RuntimeStateView } from '@/lib/runtime/types';

type Props = {
  forgeName: string;
  runtime: RuntimeStateView | null;
  canWrite: boolean;
  onStart: () => void | Promise<void>;
};

const LABEL: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'Forge is stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
  'setup-failed': 'Setup failed',
};

export function InstancePanel({ forgeName, runtime, canWrite, onStart }: Props) {
  if (runtime?.status === 'running') {
    const url = `http://localhost:${runtime.port}`;
    return (
      <div className="relative flex flex-col h-full">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-ink-faint">
          <span className="truncate">{forgeName} · localhost:{runtime.port}</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-dim hover:text-ink">
            <ExternalLink className="h-3 w-3" /> standalone
          </a>
        </div>
        <iframe src={url} className="flex-1 border-0 bg-white" title={`${forgeName} live preview`} />
      </div>
    );
  }
  const status = runtime?.status ?? 'stopped';
  return (
    <div className="grid place-items-center h-full p-6">
      <div className="text-center">
        <div className="text-base text-ink-dim mb-3">{LABEL[status]}</div>
        {(status === 'stopped' || status === 'crashed' || status === 'setup-failed') && canWrite ? (
          <button
            type="button"
            onClick={() => onStart()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-dim hover:bg-panel-3 hover:text-ink"
          >
            <Play className="h-3.5 w-3.5" /> Start forge
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/(app)/forges/[id]/InstancePanel.tsx
git commit -m "feat(forge-page): InstancePanel (iframe when running, status card otherwise)"
```

---

## Task 13: ForgePageClient — split layout + state composition

**Files:**
- Create: `app/(app)/forges/[id]/ForgePageClient.tsx`
- Test:   `app/(app)/forges/[id]/ForgePageClient.test.tsx`

> **Spec deviation captured:** the spec calls for a *draggable* splitter (default 40/60). This task ships a fixed 40% left / 60% right layout with hard min-widths. Adding the drag interaction (pointer events + clamped useState) is a small follow-up that doesn't affect the data flow or any other component. The deviation is intentional to keep this task focused; capture as a follow-up in `docs/superpowers/plans/2026-05-08-followups.md` after the slice ships.

- [ ] **Step 1: Write the failing tests**

`app/(app)/forges/[id]/ForgePageClient.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgePageClient } from './ForgePageClient';

const forge = { id: 'f1', name: 'Aquaflow Designer', createdBy: { id: 'u1', name: 'Maya' } };

vi.mock('./ChatPanel', () => ({ ChatPanel: ({ conversationId }: { conversationId: string | null }) =>
  <div data-testid="chat-panel">conv={conversationId ?? 'null'}</div>
}));
vi.mock('./InstancePanel', () => ({ InstancePanel: () => <div data-testid="instance-panel" /> }));

describe('ForgePageClient', () => {
  it('selects an existing conversation by clicking it', async () => {
    const onCreate = vi.fn();
    render(<ForgePageClient
      forge={forge}
      runtime={null}
      canWrite
      currentUserId="u1"
      initialConversations={[
        { id: 'c1', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'Setup', hasClaudeSessionId: true, createdAt: '2026-05-09T00:00Z', updatedAt: '2026-05-09T00:00Z' },
      ]}
      onCreateConversation={onCreate}
    />);
    expect(screen.getByTestId('chat-panel').textContent).toContain('conv=null');
    await userEvent.click(screen.getByText('Setup'));
    expect(screen.getByTestId('chat-panel').textContent).toContain('conv=c1');
  });

  it('clicking + New invokes onCreateConversation and selects the returned id', async () => {
    const onCreate = vi.fn(async () => ({
      id: 'c-new', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' },
      title: 'New conversation', hasClaudeSessionId: false,
      createdAt: '2026-05-10T00:00Z', updatedAt: '2026-05-10T00:00Z',
    }));
    render(<ForgePageClient
      forge={forge}
      runtime={null}
      canWrite
      currentUserId="u1"
      initialConversations={[]}
      onCreateConversation={onCreate}
    />);
    await userEvent.click(screen.getByRole('button', { name: /\+ new/i }));
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('conv=c-new'));
    expect(onCreate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `pnpm test 'app/(app)/forges/[id]/ForgePageClient.test.tsx'`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `ForgePageClient.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ConversationList } from './ConversationList';
import { ChatPanel } from './ChatPanel';
import { InstancePanel } from './InstancePanel';
import type { ConversationDto } from '@/lib/services/conversations';
import type { RuntimeStateView } from '@/lib/runtime/types';

type Props = {
  forge: { id: string; name: string; createdBy: { id: string; name: string } };
  runtime: RuntimeStateView | null;
  canWrite: boolean;
  currentUserId: string;
  initialConversations: ConversationDto[];
  onCreateConversation: () => Promise<ConversationDto>;
};

export function ForgePageClient({
  forge, runtime, canWrite, initialConversations, onCreateConversation,
}: Props) {
  const [conversations, setConversations] = useState<ConversationDto[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function handleCreate() {
    const created = await onCreateConversation();
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
  }

  async function handleStart() {
    try { await fetch(`/api/forges/${forge.id}/start`, { method: 'POST' }); } catch { /* swallow */ }
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-[12px] text-ink-dim hover:text-ink">
          <ChevronLeft className="h-3.5 w-3.5" /> Forges
        </Link>
        <div className="text-[13px] font-medium tracking-tight">{forge.name}</div>
        <div className="w-[80px]" />
      </header>
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-[40%] min-w-[280px] flex-col border-r border-border">
          <div className="border-b border-border p-3">
            <ConversationList
              items={conversations}
              activeId={activeId}
              canWrite={canWrite}
              onSelect={setActiveId}
              onCreate={() => { void handleCreate(); }}
            />
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatPanel forgeId={forge.id} conversationId={activeId} />
          </div>
        </aside>
        <section className="flex-1 min-w-[320px]">
          <InstancePanel
            forgeName={forge.name}
            runtime={runtime}
            canWrite={canWrite}
            onStart={() => { void handleStart(); }}
          />
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `pnpm test 'app/(app)/forges/[id]/ForgePageClient.test.tsx'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/(app)/forges/[id]/ForgePageClient.tsx app/(app)/forges/[id]/ForgePageClient.test.tsx
git commit -m "feat(forge-page): ForgePageClient composes split layout"
```

---

## Task 14: Page (RSC) + dashboard linking

**Files:**
- Create: `app/(app)/forges/[id]/page.tsx`
- Modify: `app/(app)/dashboard/ForgeCard.tsx`
- Modify: `app/(app)/dashboard/ForgeCard.test.tsx`

- [ ] **Step 1: Create `app/(app)/forges/[id]/page.tsx`**

```tsx
import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getForge } from '@/lib/services/forges';
import { listConversations, createConversation } from '@/lib/services/conversations';
import { getRuntimeService } from '@/lib/services/runtime';
import { canWriteForge } from '@/lib/acl';
import { prisma } from '@/lib/prisma';
import { ForgePageClient } from './ForgePageClient';

export const dynamic = 'force-dynamic';

export default async function ForgePage(
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { id } = await params;
  let forge: Awaited<ReturnType<typeof getForge>>;
  try { forge = await getForge(session.user, id); } catch { notFound(); }

  const [runtime, conversations, forgeRow] = await Promise.all([
    getRuntimeService().getRuntime(session.user, forge.id),
    listConversations(session.user, forge.id),
    prisma.forge.findUnique({
      where: { id: forge.id },
      include: { groups: { include: { group: true } } },
    }),
  ]);

  const canWrite = forgeRow ? canWriteForge(session.user, {
    id: forgeRow.id,
    createdById: forgeRow.createdById,
    groups: forgeRow.groups.map((fg) => fg.group.name),
  }) : false;

  async function onCreateConversation() {
    'use server';
    const me = await auth();
    if (!me?.user) throw new Error('Unauthorized');
    return createConversation(me.user, forge.id);
  }

  return (
    <ForgePageClient
      forge={{ id: forge.id, name: forge.name, createdBy: forge.createdBy }}
      runtime={runtime}
      canWrite={canWrite}
      currentUserId={session.user.id}
      initialConversations={conversations}
      onCreateConversation={onCreateConversation}
    />
  );
}
```

- [ ] **Step 2: Wrap dashboard card body in `<Link>`**

In `app/(app)/dashboard/ForgeCard.tsx`:

(a) Add to imports:

```tsx
import Link from 'next/link';
```

(b) Wrap the existing JSX inside the `<article>`'s top portion (the header + description + groups area, but NOT the action row at the bottom that has Edit/Delete/runtime controls) with a `<Link>`. Concretely, find the block starting `<div className="flex items-start gap-3.5">` and ending at `<div className="flex flex-wrap gap-1.5">…</div>` (the group chips), and wrap that whole region:

```tsx
<Link href={`/forges/${forge.id}`} className="flex flex-col gap-4 outline-none focus-visible:ring-2 focus-visible:ring-gold/60 rounded-md">
  {/* existing header / description / groups JSX unchanged */}
</Link>
```

The footer row with Edit / Delete / `<ForgeCardRuntime>` is *outside* the Link so its buttons remain clickable.

- [ ] **Step 3: Update `ForgeCard.test.tsx`**

Search for any test that asserts a click on the card body. If a test relies on the old non-link behaviour, update its expectation. If `next/navigation` mocks aren't already in place, add to the test file's top:

```tsx
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) =>
  <a href={href}>{children}</a>
}));
```

- [ ] **Step 4: Run all dashboard + new-page tests**

Run: `pnpm test app/(app)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/forges/[id]/page.tsx app/(app)/dashboard/ForgeCard.tsx app/(app)/dashboard/ForgeCard.test.tsx
git commit -m "feat(forge-page): page.tsx RSC + link card body to /forges/[id]"
```

---

## Task 15: E2E — open a forge, send a prompt, verify persistence

**Files:**
- Create: `tests/e2e/fixtures/claude-stub.js`
- Create: `tests/e2e/forge-open.spec.ts`

- [ ] **Step 1: Write the claude stub**

`tests/e2e/fixtures/claude-stub.js`:

```js
#!/usr/bin/env node
// Deterministic stand-in for the `claude` CLI. Reads "user" lines from stdin
// (terminated by Enter) and emits a fake assistant reply. Also writes a
// session JSONL transcript so the watcher imports it into the DB.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const sessionId = process.argv.slice(2).find((a) => a.startsWith('--resume='))?.replace('--resume=', '')
  ?? crypto.randomUUID();
const cwd = process.cwd();
const projectDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
fs.mkdirSync(projectDir, { recursive: true });
const file = path.join(projectDir, `${sessionId}.jsonl`);
function emit(line) { fs.appendFileSync(file, JSON.stringify(line) + '\n'); }

process.stdout.write(`stub-claude session ${sessionId}\n> `);
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: line }] }, sessionId });
    const reply = `you said: ${line}`;
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, sessionId });
    process.stdout.write(`${reply}\n> `);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
```

Make it executable in the script (Step 4 below).

- [ ] **Step 2: Forward `PATH` shim and `CRYSTAL_FORGE_HOME` in `playwright.config.ts`**

In the existing `webServer.env` block, add:

```ts
PATH: `${process.cwd()}/tests/e2e/fixtures/bin:${process.env.PATH ?? ''}`,
```

Then create `tests/e2e/fixtures/bin/claude` as a 2-line wrapper:

```sh
#!/usr/bin/env bash
exec node "$(dirname "$0")/../claude-stub.js" "$@"
```

- [ ] **Step 3: Write the e2e**

`tests/e2e/forge-open.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.CRYSTAL_FORGE_HOME ?? './.test-forge-home';
const SLUG = 'aquaflow-designer';
const FORGE_NAME = 'Aquaflow Designer';

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

async function prewarm() {
  const clone = path.resolve(HOME, 'clones', SLUG);
  await fs.mkdir(path.join(clone, '.git'), { recursive: true });
  await fs.mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(clone, '.env.example'), 'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow_designer\n');
  await fs.writeFile(path.join(clone, 'package.json'), JSON.stringify({
    name: SLUG,
    scripts: {
      dev: 'node server.js',
      prisma: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  await fs.writeFile(path.join(clone, 'server.js'),
    `require('http').createServer((_,res)=>res.end('Welcome to ${FORGE_NAME}')).listen(process.env.PORT||3000)\n`);
}

test('open forge → start → new conversation → message round trip → persistence', async ({ page }) => {
  await devLogin(page, 'maya.chen@crystalfountains.com');
  await prewarm();

  await page.goto('/dashboard');
  await page.locator('article', { hasText: FORGE_NAME }).getByText(FORGE_NAME).click();
  await expect(page).toHaveURL(/\/forges\/[0-9a-f-]+/);

  // Right pane shows Stopped → Start.
  await page.getByRole('button', { name: /start forge/i }).click();
  await expect(page.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  // Iframe content reachable through the page object.
  const iframeUrl = await page.locator('iframe').first().getAttribute('src');
  expect(iframeUrl).toMatch(/^http:\/\/localhost:30\d\d$/);

  // Start a new conversation.
  await page.getByRole('button', { name: /\+ new/i }).click();

  // Wait for xterm host to appear and type a prompt.
  await expect(page.getByTestId('xterm-host')).toBeVisible();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');

  // The stub-claude reply should land in the terminal within a few hundred ms.
  await expect(page.locator('body')).toContainText(/you said: hello/i, { timeout: 5_000 });

  // Reload — conversation should persist with the auto-derived title.
  await page.reload();
  await expect(page.getByText('hello', { exact: false })).toBeVisible({ timeout: 5_000 });
});
```

- [ ] **Step 4: Make the stub + wrapper executable**

Run:

```bash
mkdir -p tests/e2e/fixtures/bin
# (after writing the files)
chmod +x tests/e2e/fixtures/claude-stub.js tests/e2e/fixtures/bin/claude
```

- [ ] **Step 5: Run the E2E**

Run:

```bash
pnpm e2e tests/e2e/forge-open.spec.ts
```

Expected: PASS in ~30–60s (most of it is waiting for the forge to flip to Running).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/forge-open.spec.ts tests/e2e/fixtures playwright.config.ts
git commit -m "test(e2e): open forge → new conversation → round-trip → reload persists"
```

---

## Final verification

- [ ] **Run the full suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

Expected: all pass. Confirm `[instrumentation] runtime WS server listening on 3100` (or the configured port) appears in `pnpm dev` output.

- [ ] **Manual smoke**

1. Click into "Aquaflow Designer". Right pane shows Stopped. Click Start; iframe renders the welcome page.
2. Click + New. Terminal appears. Type `/help` and Enter. Confirm Claude responds.
3. Open the database: `docker exec crystal-forge-pg psql -U crystal -d crystal_forge -c "SELECT id, title FROM conversations ORDER BY updated_at DESC LIMIT 5;"`. Confirm a new row exists with a sensible title.
4. Open a second tab to the same forge. Open the same conversation. Confirm the second tab gets a 4409 close code and shows "already active in another tab".
5. Reload the first tab. Confirm the conversation persists in the list and resuming continues the session (visible because Claude's session greeting reflects prior history).
