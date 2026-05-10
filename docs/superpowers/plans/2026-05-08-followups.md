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
