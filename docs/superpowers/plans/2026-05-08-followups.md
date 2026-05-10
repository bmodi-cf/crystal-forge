# Follow-ups — observed during real-mode dry-run (2026-05-08)

Two separate issues surfaced while exercising the first real-mode forge create
against `bmodi-cf` (`GITHUB_CLIENT_MODE=real`, `crystal-forge-api` GitHub App).
Both are pre-existing — neither was introduced by the ACL / membership work
or the test-DB isolation that landed earlier the same day. Capturing here so
they don't get lost.

---

## 1. `OctokitGitHubClient.archiveRepo` swallows 404 from GitHub

**Observed:** Alice deleted the stale fake-mode `crystal-lattice` row.
The dev-server log showed `PATCH /repos/bmodi-cf/crystal-lattice 404` (the
repo never existed on GitHub — it only ever lived in the previous run's
in-memory `FakeGitHubClient`), yet `DELETE /api/forges/<id>` returned `204`
and the row was deleted. So the archive failure was treated as success.

**Why it matters:** `lib/services/forges.ts:194-218` (`deleteForge`) is
explicit that archive runs **before** the DB delete — "if archive fails,
abort. Better to leave a usable Forge than a broken repo↔row link." A 404
from `archiveRepo` slipping through silently breaks that contract for any
non-fake-mode path. In real day-to-day operation a 404 here is rare, but it
masks any case where the repo is gone for a real reason (manually deleted,
ownership transferred, App lost access).

**Where to look:**
- `lib/github/octokit-client.ts` — the `archiveRepo` implementation. Likely
  catching errors too broadly, or using an Octokit method that doesn't throw
  on 4xx.
- `lib/github/fake-client.ts:38-43` is intentionally idempotent on unknown
  repos (matches the spec §3 idempotency note). Decide whether the real
  client should match that — and whether the spec's "idempotent" wording
  was meant to cover "repo doesn't exist" or only "already archived".

**Recommended direction:** make `OctokitGitHubClient.archiveRepo` throw on
404 (genuine "repo missing" — user-actionable) but continue to no-op on the
"already archived" case (HTTP 200/422 idempotent path). Add a unit test
against a stub Octokit that returns 404, asserting the method throws. Then
revisit `FakeGitHubClient.archiveRepo` so its behaviour matches the real
client — currently they diverge silently.

---

## 2. Hydration mismatch on `ForgeCard.tsx:41` — date locale drift

**Observed:** Every dashboard load logs a React hydration warning. Server
renders `2026-05-08` (ISO-ish), client renders `5/8/2026` (US locale via
`Intl`/`toLocaleDateString`). React regenerates the subtree client-side, so
the UI is visually correct, but every page nav pays a hydration penalty
and the noisy warning hides real errors when they appear.

**Where to look:**
- `app/(app)/dashboard/ForgeCard.tsx:41-43` — the `updated` line. The format
  string differs between SSR and the browser because the server has no
  user-locale context.

**Recommended direction:** pick one canonical format and render it the same
way on both sides. Cheapest fix is `forge.updatedAt.slice(0, 10)` (ISO date
prefix from the DTO, deterministic everywhere). If we want a friendlier
"updated 3 days ago" or locale-aware date, do it inside a client-only
component (mark with `'use client'` and hydrate from `useEffect`, or use
`suppressHydrationWarning` on the specific node) — never compute locale-
dependent dates during SSR.

Either fix is small. The format choice is a design call.

---

## Added 2026-05-09 — observed during orchestration slice (Start/Stop/Open) final review

The 15-task orchestration slice (`docs/superpowers/plans/2026-05-09-forge-orchestration-start-stop-open.md`) shipped at commit `a4a9976`. The final integration review surfaced three minor items not worth blocking the slice but worth capturing.

---

## 3. Slug-rename orphans an existing clone directory

**Observed:** `lib/services/runtime.ts:68` recomputes `slug = slugifyForgeName(row.name)` on every Start. Forge names are currently immutable (the edit modal renders the name as static text — see the e2e in `tests/e2e/dashboard-crud.spec.ts`), so this never bites today. But if a future slice unfreezes name editing, the next Start after a rename would clone into a new directory under `~/.crystal-forge/clones/<new-slug>/` and silently leave `~/.crystal-forge/clones/<old-slug>/` behind.

**Why it matters:** orphaned clone directories accumulate on disk indefinitely. Each one carries a full `node_modules` (~500 MB after `pnpm install`). The harness has no GC for them today.

**Where to look:**
- `lib/services/runtime.ts:68` — the slug derivation.
- `prisma/schema.prisma` — `Forge` table, currently no `slug` column.

**Recommended direction:** if name editing stays disabled, add a one-line code comment at the slug derivation noting the assumption. If name editing lands, the cleanest fix is storing `slug` on the `Forge` row at create time (it's already computed during `createForge` in `lib/services/forges.ts`) and reading it back in the runtime service. That makes the slug stable across renames and avoids the orphan path entirely.

---

## 4. `OctokitGitHubClient.getInstallationToken` relies on an unbound `auth` callable

**Observed:** `lib/github/octokit-client.ts:103-107` extracts `this.client.auth` and calls it without `this`:

```ts
const auth = (this.client as unknown as {
  auth: (opts: { type: 'installation' }) => Promise<{ token: string }>;
}).auth;
const result = await auth({ type: 'installation' });
```

This works today because `@octokit/auth-app@8.2.0` binds state via closure (`auth.bind(null, state)`) rather than `this`. But the `as unknown as` cast bypasses type safety entirely, so a future Octokit major upgrade could change the contract silently — typescript wouldn't catch the regression.

**Why it matters:** Crystal Forge tracks the Octokit major in `package.json` (`@octokit/rest@^22.0.1`, `@octokit/auth-app@^8.2.0`). A bump that re-binds `auth` to the Octokit instance would break `git clone` for every forge.

**Where to look:**
- `lib/github/octokit-client.ts:103-107`.
- `lib/github/octokit-client.test.ts` — covers the happy path with a stubbed `vi.fn`, but doesn't catch the `this`-binding contract.

**Recommended direction:** keep the call inline and add a one-line comment that documents the reliance on `bind(null, state)`. Alternatively, switch to `await (this.client as unknown as Foo).auth({ type: 'installation' })` (one expression instead of destructuring) so the call site can't be accidentally dethemed. A more invasive option — extracting the App auth strategy as a separate constructor dep — is overkill for a one-line concern.

---

## 5. `ForgeCardRuntime` accepts `forgeId` / `forgeName` props but never reads them

**Observed:** `app/(app)/dashboard/ForgeCardRuntime.tsx:36` destructures `forgeId: _id, forgeName: _name` — the underscore prefixes correctly silence the unused-prop lint rule, but the props are passed from `ForgeCard.tsx` and never used in the component's JSX.

**Why it matters:** mostly clarity. A reader looking at the prop type expects the values to flow somewhere. They don't.

**Where to look:**
- `app/(app)/dashboard/ForgeCardRuntime.tsx:11-17` (Props), `:36` (destructure).
- `app/(app)/dashboard/ForgeCard.tsx` — the call site.

**Recommended direction:** decide whether the props are forward-looking. If a future slice needs them (e.g. an aria-label like "Start Marketing Fru Fru" instead of bare "Start", or a log-tail link keyed by forgeId), wire them up now or leave a one-line comment stating the intent. If they aren't forward-looking, drop them from `Props` and from the `ForgeCard` call site to reduce the surface.

---

## Added 2026-05-10 — observed during open-forge slice (split view + Claude transcripts) final review

The 15-task open-forge slice (`docs/superpowers/plans/2026-05-10-open-forge-split-view.md`) shipped at commit `1b45e47`. The final integration review surfaced these items.

---

## 6. WS server's `pty.onExit` and `ws.on('close')` both call cleanup — sequencing relies on idempotent helpers

**Observed:** In `lib/runtime/ws-server.ts`, when a PTY exits naturally:
1. `pty.onExit` fires → calls `watcher.stop()`, `sessions.delete(conv.id)`, `ws.close(4000, ...)`.
2. The `ws.close` triggers `ws.on('close')` → calls `pty.kill()` (no-op, dead pid), `watcher.stop()` (idempotent), `sessions.delete(conv.id)` (idempotent).

Nothing crashes — `pty.kill()` is wrapped in try/catch, `watcher.stop()` has a `stopped = true` guard, and `Map.delete` is idempotent. But the fact that correctness depends on every helper being defensively idempotent is brittle.

**Why it matters:** if any of those helpers ever loses its idempotency guard (e.g., a future fix adds an early `throw if already stopped`), the second cleanup path crashes. The sequencing is also noisy in logs.

**Where to look:**
- `lib/runtime/ws-server.ts:60-85` — the two cleanup paths.

**Recommended direction:** introduce a `let cleanedUp = false` guard in the connection handler and short-circuit either path. Or — preferably — let `ws.on('close')` own teardown exclusively and have `pty.onExit` only call `ws.close()` (which fires `'close'`, which does the rest). The latter is cleaner but assumes the WS close event always fires reliably, which is true for graceful close but not for abrupt socket errors.

---

## 7. `CRYSTAL_FORGE_WS_SECRET` dev fallback applies in any non-production env

**Observed:** `lib/env.ts:85-87` auto-generates a known sentinel secret (`'dev-only-' + 'x'.repeat(16)`) when the env var is unset. The production guard at line 62 only triggers when `NODE_ENV === 'production'`. Any staging-like environment (e.g., `NODE_ENV=staging`) would silently use the predictable secret.

**Why it matters:** if Crystal Forge ever runs in a non-`production` non-`development` environment (e.g., a hosted dev preview), tickets become forgeable by anyone who reads the source. For the current single-developer dev tool this is fine; if the deployment story ever broadens this becomes a real exposure.

**Where to look:**
- `lib/env.ts:62-71` (production guard) and `:85-87` (dev fallback).

**Recommended direction:** require the secret unless `NODE_ENV === 'test'`, and make the dev fallback log a warning to stderr so it's at least visible. Or accept the risk explicitly in a comment until deployment broadens.

---

## 8. `appendMessage` issues sequential DB writes without a transaction

**Observed:** `lib/services/conversations.ts:125-137` does `message.create` → `conversation.update({updatedAt})` → conditional `maybeBackfillTitle` (one read + one update). If the harness dies between the first two writes, the message exists but `conversation.updatedAt` is stale (so list-by-recent-activity is wrong).

**Why it matters:** under load or sudden harness restart, conversation ordering can drift from message reality. Not catastrophic for an audit log, but the kind of low-grade inconsistency that's hard to debug later.

**Where to look:**
- `lib/services/conversations.ts:125-137`.

**Recommended direction:** wrap `message.create` + `conversation.update` in `prisma.$transaction()`. Title backfill can stay outside the transaction since it's best-effort.

---

## 9. `MessageRole` enum vs DTO string-literal union — silent drift risk

**Observed:** `lib/services/conversations.ts:24` and `:92-95` declare `messages[].role: 'user' | 'assistant'` (a string-literal union) but Prisma returns the `MessageRole` enum. The mapping at line 94 (`role: m.role`) succeeds because the structures are compatible. If Prisma ever adds a new enum value (e.g., `tool` for richer transcript capture — flagged as a possibility in the original spec but not pursued in this slice), the DTO becomes a silent lie.

**Where to look:**
- `lib/services/conversations.ts:24`, `:92-95`.
- `prisma/schema.prisma` `MessageRole` enum.

**Recommended direction:** import `MessageRole` from `@prisma/client` and use it in the DTO type, or add an `as const` assertion at the mapping site that fails-loud on enum extension. Cheap and future-proofing.

---

## 10. `encodedCwd` regex duplicated between watcher and stub

**Observed:** Two places encode cwd → project-dir name with the same regex (replace `/` and `.` with `-`):
- `lib/runtime/transcript-watcher.ts:22` — `cwd.replace(/[/.]/g, '-')`.
- `tests/e2e/fixtures/claude-stub.js:13` — `cwd.replace(/[\/.]/g, '-')`.

Logically identical, but the stub is a plain CJS file that can't import from TypeScript. The two will silently drift if Claude Code ever changes its directory-encoding scheme.

**Where to look:**
- `lib/runtime/transcript-watcher.ts:22`.
- `tests/e2e/fixtures/claude-stub.js:13`.

**Recommended direction:** add a code-comment in the stub linking to the canonical `encodedCwd` function ("must mirror lib/runtime/transcript-watcher.ts encodedCwd"). Or extract the encoding into a tiny `.cjs` shared module that both can require.

---

## 11. `ForgePageClient.handleStart` swallows fetch errors

**Observed:** `app/(app)/forges/[id]/ForgePageClient.tsx:57-62` does `try { await fetch(...) } catch { /* swallow */ }` AND kicks off the runtime poll regardless. If the start request fails (auth expired, server down, 503 from RuntimeCapacityError), the user sees no feedback and the poll loop runs indefinitely.

**Where to look:**
- `app/(app)/forges/[id]/ForgePageClient.tsx:57-62`.

**Recommended direction:** check `res.ok` before starting the poll. On non-OK, surface a `toast.error` with the response message (the dashboard's existing `handleRuntimeAction` is the established pattern).

---

## 12. `<iframe>` in InstancePanel has no `sandbox` attribute

**Observed:** `app/(app)/forges/[id]/InstancePanel.tsx:34` embeds the running forge via raw `<iframe src="http://localhost:<port>">` with no `sandbox` attribute. The embedded page inherits the browser's full ambient capability.

**Why it matters:** for a developer tool where the operator controls every forge process, this is acceptable — the embedded code is *their* code. If forges ever run untrusted code (e.g., business users editing without review), the lack of sandboxing becomes meaningful.

**Where to look:**
- `app/(app)/forges/[id]/InstancePanel.tsx:34`.

**Recommended direction:** add a brief comment acknowledging the unsandboxed iframe is a deliberate trust choice. If Docker-per-forge isolation lands, also add `sandbox="allow-scripts allow-same-origin allow-forms"` (or narrower) to gate what the embedded page can do.

---

## 13. xterm → WS input path is not exercised end-to-end

**Observed:** The Playwright e2e (`tests/e2e/forge-open.spec.ts`) intentionally uses `page.routeWebSocket(...)` to inject input directly into the WebSocket, bypassing xterm because xterm's helper-textarea is positioned at `left: -9999em` and Playwright's keyboard simulation can't reach it in headless mode. This means `useChatSession.send()` (which wraps data in `{type:'input', data}`) is exercised only by the unit test's mock — never against a real WebSocket.

**Why it matters:** if `useChatSession` ever switched from `JSON.stringify({type:'input', data})` to raw bytes, both unit tests and e2e would still pass, but the WS server would write binary instead of the parsed string.

**Where to look:**
- `tests/e2e/forge-open.spec.ts` — uses `page.routeWebSocket` to inject input.
- `app/(app)/forges/[id]/useChatSession.ts:67-69` — the `send` wrapper.
- `lib/runtime/ws-server.ts:74-86` — the input parser.

**Recommended direction:** add a small integration test in `lib/runtime/ws-server.test.ts` (or a new test file) that opens a real WebSocket, sends a `{type:'input', data}` message, and asserts the PTY receives the unwrapped data. This catches drift between client/server protocol without needing xterm at all.

---

## 14. Spec deviation: static 40/60 split instead of draggable splitter

**Observed:** The spec for the open-forge slice (`docs/superpowers/specs/2026-05-10-open-forge-split-view-design.md` §3 B) called for a "draggable splitter (default 40/60)". The implementation in `app/(app)/forges/[id]/ForgePageClient.tsx` ships a fixed 40% left / 60% right with hard min-widths.

**Why it matters:** users with wide monitors may want more chat width; users on smaller screens may want more iframe width. Static split is a UX limitation, not a correctness issue.

**Where to look:**
- `app/(app)/forges/[id]/ForgePageClient.tsx` — the static `<aside className="w-[40%] min-w-[280px]">`.

**Recommended direction:** add a draggable splitter — pointerdown/pointermove on a 4px-wide divider element, useState for the percentage, clamped to [20, 80]. Probably 30-50 lines of straightforward React. Persist the chosen percentage to localStorage so it survives refresh.
