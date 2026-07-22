# Forge display name + remove forge initials

**Date:** 2026-07-22
**Status:** Design approved
**Repo:** crystal-forge (dashboard) + a live pilot DB migration

## Problem

A forge's human label and its runtime slug are the same field: `Forge.name` is the
`@unique` display name AND the live slug source (`slugifyForgeName(row.name)` at
`lib/services/runtime.ts:87`; there is no stored slug). The slug keys the container,
both Docker volumes, the per-forge DB, and the `/app/<slug>` URL — so renaming a forge to
fix its label would re-slug it and orphan its volumes/DB. We need to relabel a forge
(e.g. "Work Order Drawing Printing Tool" → "Work Order Print Tool") **without** re-slugging.

Separately, the per-forge `initials` badge (e.g. "WO") shown on dashboard forge cards adds
little value and is redundant once a display name exists; remove it.

## Decisions

- Add an optional **`displayName`** used purely for presentation; `name`/slug/URL/volumes
  are never touched. UI renders `displayName || name`.
- `displayName` is **editable in the forge Edit dialog** (not create — new forges default to
  showing `name`).
- **Remove `Forge.initials`** entirely (schema, DB, services, UI, form, tests, seed).
  `User.initials` (topbar avatar) is unrelated and stays.
- Removing the badge orphans `components/forge-tone.ts` (its only consumer is the badge) →
  delete it. The `Forge.tone` column becomes UI-vestigial but is **left in place** (not in
  scope to drop; avoids extra churn).

## Changes (dashboard repo)

### Schema + migration (`prisma/schema.prisma`)
- `Forge`: add `displayName String? @map("display_name")`; remove `initials String`.
- `pnpm db:migrate` to generate + apply; then backfill this forge:
  `UPDATE forges SET display_name='Work Order Print Tool' WHERE name='Work Order Drawing Printing Tool';`

### Services (`lib/services/forges.ts`, `lib/services/types.ts`)
- `Forge` DTO / type: add `displayName: string | null`; remove `initials`.
- `toDto`: map `displayName`, drop `initials`.
- `createForge`: drop `initials: deriveInitials(input.name)`; remove the now-unused
  `deriveInitials` helper.
- `updateForge` + the edit input type: accept optional `displayName` (trim; empty → null).

### UI
- Render `forge.displayName || forge.name` wherever the human label shows:
  `LaunchCard.tsx` (title + aria-label), `ForgeCard.tsx` (title + aria-labels + `forgeName`
  props), `ForgePageClient.tsx`, `app/(app)/forges/[id]/page.tsx`, `ForgeFormModal.tsx`
  (delete-confirm text), `DashboardClient.tsx` (toast).
- `ForgeCard.tsx`: remove the tone-colored initials `<div>`; let the title/creator column
  take the row. Remove the `TONE_CLASSES` import.
- Delete `components/forge-tone.ts`.
- `ForgeFormModal.tsx`: add optional "Display name" field to the **edit** schema + form; pass
  through on submit to `updateForge`.

### Tests + seed
- Drop forge `initials` from fixtures/assertions: `ForgeCard.test.tsx`, `LaunchCard.test.tsx`,
  `ForgeFormModal.test.tsx`. Add a `displayName || name` fallback assertion where sensible.
- `prisma/seed.ts`: remove `initials` from the forge seed objects (keep user `initials`);
  `displayName` left unset (seeds show `name`).

## Rollout / verification
1. Edit schema + code + tests.
2. `pnpm db:migrate` (creates + applies migration), backfill SQL for this forge.
3. `pnpm test` + `pnpm typecheck` + `pnpm lint` green.
4. Restart `crystal-forge.service`.
5. Verify: dashboard/Launch cards show "Work Order Print Tool", no "WO" badge; Edit dialog
   has a working Display name field; other forges still render their `name`.

## Out of scope
- Dropping the `Forge.tone` column. Adding `displayName` to the create form. Any change to
  the forge slug/URL/volumes. `User.initials`.
