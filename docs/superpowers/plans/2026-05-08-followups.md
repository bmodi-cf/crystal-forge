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
