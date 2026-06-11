# Bug report: deleting a Forge returns 500 Internal Server Error

**Status:** Open — diagnosed, not fixed
**Reported:** 2026-06-11
**Severity:** Medium (blocks deletion of affected Forges; pilot is live)
**Reported against:** "Showcase Gallery" forge — delete fails repeatedly with 500

## Symptom

Deleting a Forge from the dashboard returns `500 Internal Server Error`.
Observed reproducibly against the "Showcase Gallery" forge.

## Where it comes from

`deleteForge` in `lib/services/forges.ts` (~line 327) has two unguarded
external boundaries, executed in order:

1. `client.archiveRepo(existing.repoFullName)` — GitHub (line ~348)
2. `prisma.forge.delete({ where: { id } })` — DB (line ~350)

Any throw from either propagates to the route handler
(`app/api/forges/[id]/route.ts` `DELETE`), which calls
`respondToServiceError` (`lib/http.ts`). For unrecognized errors that helper
logs a single generic line and returns `500 Internal Server Error`:

```
console.error('[respondToServiceError] unhandled error', err);
return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
```

**Observability gap:** because neither boundary is individually instrumented,
the current logs cannot tell us *which* step failed (GitHub vs DB), nor the
underlying HTTP status / Prisma error code. That is the first thing to fix so
the next occurrence is diagnosable.

## Leading hypotheses

### 1. GitHub archive rejects (most likely, given it's one specific Forge)

`octokit-client.ts#archiveRepo` swallows 404 but **rethrows everything else**:

```ts
async archiveRepo(fullName: string): Promise<void> {
  const [owner, repo] = parseFullName(fullName);
  try {
    await this.client.repos.update({ owner, repo, archived: true });
  } catch (err: unknown) {
    if (isStatus(err, 404)) return;
    throw err;
  }
}
```

A `403` (insufficient GitHub App permission, or repo already archived /
read-only) or `401` (auth) on that specific repo would produce exactly this
500. The service runs with `GITHUB_CLIENT_MODE=real`. That a single Forge
fails while others delete fine points at something repo-specific rather than a
global outage.

### 2. DB delete FK violation (schema drift)

`schema.prisma` declares `onDelete: Cascade` on every relation that references
`Forge` (`Conversation`, `Message` via conversation, `ForgeGroup`), so an
in-spec DB should cascade cleanly. **But** if the live pilot DB drifted from
the schema (a constraint created without `ON DELETE CASCADE`), deleting a Forge
that *has* conversations/messages would raise a Prisma `P2003` foreign-key
violation — while Forges with no children would still delete fine. Consistent
with the "only this Forge" symptom if Showcase Gallery is the one with
conversation history.

## Recommended first step (observability, not a fix)

Wrap each boundary in `deleteForge` with a targeted `catch` that logs and
rethrows the original error (behavior unchanged — still a 500), capturing:

- GitHub step: the HTTP `status` and message.
- DB step: the Prisma error `code` and `meta` (distinguishes `P2003`
  FK-violation from a `P2025` row-vanished race).

Plus an entry/exit `console.info` so the failing step is unambiguous. This is
log-only and can ship on a branch, to be rolled out during a quiet window or a
controlled restart — **not** while the pilot is in active use.

Once a real failure is captured with that instrumentation, fix the actual root
cause (GitHub permission/state handling, or a corrective migration to restore
the missing cascade).

## Notes / constraints

- Pilot service is **live and in active use** — do not hot-patch the running
  deployment. Stage changes on a branch and deploy on a controlled restart.
- The running server (uid 1001) logs to `/workspace/.forge-dev.log` inside the
  service's own filesystem view; it is not readable from a normal dev shell.

## Relevant files

- `lib/services/forges.ts` — `deleteForge`
- `app/api/forges/[id]/route.ts` — `DELETE` handler
- `lib/http.ts` — `respondToServiceError`
- `lib/github/octokit-client.ts` — `archiveRepo`
- `prisma/schema.prisma` — `Forge` / `Conversation` / `Message` / `ForgeGroup` relations
