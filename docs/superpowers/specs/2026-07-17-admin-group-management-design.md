# Admin Group Management — Design

**Date:** 2026-07-17
**Status:** Approved (ready for implementation plan)

## Summary

Add a **Groups** tab to the `/admin` section that lets an admin manage the full
group lifecycle from one place: create, rename, and delete groups, and add or
remove users from a group. Today groups and their memberships are populated only
by `prisma/seed.ts` — there is no runtime UI for either. Group membership drives
forge visibility (a user sees a forge when they share a group with it), so this
gives admins first-class control over access without re-seeding.

No schema changes are required: `Group` and `UserGroup` already exist.

## Goals

- Admins can create a new group, rename an existing group, and delete a group.
- Admins can view a group's members and add/remove users.
- Deleting a group that is still in use is allowed but gated behind an
  impact-count confirmation, because `ForgeGroup`/`UserGroup` cascade-delete.
- The `/admin` shell is widened so the nav sits flush-left and the content area
  has room for a groups table beside a selected-group detail panel.

## Non-Goals

- No changes to how forges are assigned to groups (that stays in the forge
  edit surface).
- No bulk import/export of groups or memberships.
- No per-group roles or permissions beyond existing membership semantics.

## Context (current state)

- `lib/services/groups.ts` exposes only `listGroups()`.
- `Group` (`name` unique) ↔ `UserGroup` (`@@id([userId, groupId])`, both FKs
  `onDelete: Cascade`) ↔ `User`. `Group` also has `ForgeGroup[]` (also
  cascade-delete).
- ACL (`lib/acl.ts`) matches forges to users **by group name**:
  `SessionUser.groups` is a list of group *names* recomputed from the DB on each
  session load (`getSessionUserById`). ⇒ **Renaming a group is ACL-safe**
  (relations are by id; names refresh per session). **Deleting a group is the
  destructive operation** — it removes the group from every forge and user.
- `/admin` already has **Users** (role dropdown) and **Promotions** tabs.
  `AdminNav.tsx` renders the left nav; `admin/layout.tsx` renders the content
  slot. The admin shell is `mx-auto max-w-6xl px-8`, which centers the column
  and leaves a wide empty gutter left of the nav.

## Data Model

No migration. Existing models used as-is:

- `Group { id, name (unique), createdAt, members: UserGroup[], forges: ForgeGroup[] }`
- `UserGroup { userId, groupId, createdAt }` — composite PK, cascade on both FKs.

## Services — `lib/services/groups.ts`

Extend the existing file. Every function takes `currentUser: SessionUser` and
throws `ForbiddenError('Admin only')` unless `currentUser.isAdmin`, mirroring
`lib/services/users.ts`.

| Function | Behavior |
| --- | --- |
| `listGroupsForAdmin(currentUser)` | Returns `{ id, name, memberCount, forgeCount }[]`, ordered by name. Counts via `_count`. |
| `getGroupDetail(currentUser, groupId)` | Returns `{ id, name, memberCount, forgeCount, members: { id, name, email }[] }`. `NotFoundError('Group', id)` if missing. Members ordered by name. |
| `createGroup(currentUser, name)` | Trims name; `ValidationError` if empty; `ValidationError` on duplicate name (unique-constraint → mapped, not a raw Prisma throw). Returns the new group row. |
| `renameGroup(currentUser, groupId, name)` | Same name validation; `NotFoundError` if group missing. No-op-safe if the name is unchanged. |
| `deleteGroup(currentUser, groupId)` | `NotFoundError` if missing. Deletes the group (DB cascade removes `UserGroup`/`ForgeGroup`). Returns `{ memberCount, forgeCount }` captured **before** delete (for the toast / audit line). |
| `addMember(currentUser, groupId, userId)` | Idempotent upsert of `UserGroup`. `NotFoundError` if group or user missing. Returns the added member `{ id, name, email }`. |
| `removeMember(currentUser, groupId, userId)` | Idempotent delete of the `UserGroup` row (no error if not a member). `NotFoundError` if the group itself is missing. |

Duplicate-name handling: check with a `findUnique({ where: { name } })` before
insert/update and throw `ValidationError('A group with that name already exists', { name: [...] })`, so the API returns a clean 400 rather than a Prisma P2002.

The existing `listGroups()` stays (it feeds the forge-edit group picker and the
dashboard) — unchanged.

## API Routes — `app/api/admin/groups/...`

REST, Zod-validated bodies, wrapped in `respondToServiceError`, matching the
`app/api/admin/users/[id]/role/route.ts` pattern (401 if no session; delegate
authz to the service's admin guard).

| Method & path | Maps to |
| --- | --- |
| `GET  /api/admin/groups` | `listGroupsForAdmin` |
| `POST /api/admin/groups` | `createGroup` — body `{ name: string }` |
| `GET    /api/admin/groups/[id]` | `getGroupDetail` |
| `PATCH  /api/admin/groups/[id]` | `renameGroup` — body `{ name: string }` |
| `DELETE /api/admin/groups/[id]` | `deleteGroup` |
| `POST   /api/admin/groups/[id]/members` | `addMember` — body `{ userId: string }` |
| `DELETE /api/admin/groups/[id]/members` | `removeMember` — body `{ userId: string }` |

Name Zod schema: `z.object({ name: z.string().trim().min(1).max(64) })`.
Member schema: `z.object({ userId: z.string().uuid() })`.

## UI

### Admin shell layout change — `app/(app)/admin/layout.tsx`

Replace the centered `mx-auto max-w-6xl px-8` container with a full-width shell
(e.g. `w-full px-6 py-8`, keep `flex gap-8`) so `AdminNav` sits flush at the true
left edge and the content slot (`min-w-0 flex-1`) spans the remaining width.
This is a **shared** change: Users and Promotions render wider in the same space
(intended — consistent, and gives Groups room for the two-panel layout).

### Groups tab — `app/(app)/admin/groups/`

- Add `{ href: '/admin/groups', label: 'Groups' }` to `AdminNav.tsx` `ITEMS`.
- `page.tsx` (server): `auth()` guard mirroring `users/page.tsx`
  (`force-dynamic`), calls `listGroupsForAdmin(session.user)`, renders
  `<AdminGroupsClient groups={...} />`.
- `AdminGroupsClient.tsx` (client): master/detail inside the content slot.
  - **Left — groups table:** name + member count per row; selecting a row loads
    its detail. A **"New group"** action (inline input or small dialog) posting
    to `POST /api/admin/groups`, then selecting the new group.
  - **Right — selected-group detail:**
    - Editable **name** → `PATCH` (rename), with the dup-name error surfaced.
    - **Delete group** button → confirm dialog (below).
    - **Member list** with a remove (×) per member → `DELETE .../members`.
    - **Add member** control: a searchable select of users **not already in the
      group** (fed by the full user list) → `POST .../members`.

The full user list for the add-member picker is provided to the client
(the org is small); no incremental search endpoint is needed.

### Delete confirmation (guardrail)

Delete opens a confirm dialog showing the impact using the counts already loaded
for the selected group:

> "**{name}** has **N members** and **M forges**. Deleting it removes the group
> from all of them — members may lose access to those forges. This can't be
> undone."

Proceed only on explicit confirm; then `DELETE`, remove the group from the list,
and clear the detail pane.

### Interaction / feedback

Follow `AdminUsersClient` conventions: optimistic updates with revert on failure,
`sonner` toasts (`toast.success` / `toast.error` reading `body.error`), and
`aria-label`s on controls.

## Error Handling

- Service layer throws the shared typed errors (`ForbiddenError`,
  `NotFoundError`, `ValidationError`); routes translate via
  `respondToServiceError`.
- Duplicate group name → `ValidationError` → 400 with field errors (never a raw
  Prisma P2002 surfacing to the client).
- Add/remove member are idempotent so a double-click or stale UI can't 500.
- Client reverts optimistic state and toasts on any non-ok response.

## Testing

- **Unit (Vitest, colocated `lib/services/groups.test.ts`):** admin-guard
  rejection for each write fn; `createGroup`/`renameGroup` empty + duplicate
  validation; `deleteGroup` returns pre-delete counts and cascades; `addMember`
  idempotency; `removeMember` no-op when not a member; `getGroupDetail`
  `NotFoundError`.
- **Client (`AdminGroupsClient.test.tsx`, mirroring
  `AdminUsersClient.test.tsx`):** optimistic add/remove member with revert on a
  failed request; delete confirm gate; new-group happy path.
- **Existing suites** for `listGroups`, forges, and ACL must remain green
  (unchanged behavior).

## Rollout

- Additive: new tab, new routes, new service fns, one shared layout tweak. No
  migration, no seed change, no change to `listGroups`/forge assignment.
- Deploy = build + restart `crystal-forge.service` (per repo runbook); no DB
  migration step.
