# User Roles: DEVELOPER & DEFAULT_USER — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)

## Problem

Crystal Forge has a two-tier access model today: a user is either an **admin**
(global override — reads/writes any forge, sees the promotions surface) or a
**regular user** whose access comes from group membership plus ownership of
forges they created. There is no way to give someone a strictly *consumer*
experience — access to launch and use forges without the ability to create or
edit them.

We are formalizing three explicit, hierarchical, mutually-exclusive roles:

- **ADMIN** — everything (unchanged from today's `admin`).
- **DEVELOPER** — today's regular-user behavior: edit + launch, group-scoped
  forge access, write access to forges they own.
- **DEFAULT_USER** — new consumer tier: can *only* see and use **Launch**
  (open forges in their groups that are already running). No edit surface.

## Capability matrix

| | ADMIN | DEVELOPER | DEFAULT_USER |
|---|:--:|:--:|:--:|
| See/use `/launch` (open running forges in their groups) | ✅ | ✅ | ✅ |
| See/use `/dashboard` ("Edit"): create/edit forges, start/stop runtimes | ✅ | ✅ | ❌ |
| See/use `/admin` (user + promotion management) | ✅ | ❌ | ❌ |
| Forge **read** scope | all | group + owned | group only |
| Forge **write** scope (edit / start / stop) | all | owned only | none |

Notes:
- DEVELOPER's forge read/write scope is **exactly today's non-admin behavior**.
  `canReadForge` / `canWriteForge` / `forgeReadFilter` in `lib/acl.ts` are
  **unchanged**.
- A DEFAULT_USER can never create a forge (no edit surface), so `createdById`
  never points to them; the `owned` clause in the read filter is simply never
  true for them, collapsing their effective read scope to group-only with no
  special-casing.
- DEFAULT_USER opens a running forge via the live-app proxy (`/app/{slug}/`)
  from a Launch card. They do **not** reach `/forges/[id]` (the edit/chat/
  runtime detail page). Starting a runtime remains a dashboard action, so a
  DEFAULT_USER consumes forges that a DEVELOPER or ADMIN has already started.

## Decisions (from brainstorming)

1. **Default role for a newly provisioned Entra user:** `DEFAULT_USER`.
2. **Data model:** single `role` column on `User` (replaces the `UserRole`
   join table). Enforces mutual exclusivity; one source of truth.
3. **Enum casing:** normalized to UPPER_SNAKE — `ADMIN`, `DEVELOPER`,
   `DEFAULT_USER`.
4. **DEFAULT_USER on Launch:** open already-running forges only (consumer). No
   start/stop power.
5. **Role assignment:** an admin role-management UI (this iteration).
6. **Admin surface:** a new `/admin` section reached from a header **ADMIN**
   nav button; it hosts both **user management** and **promotion management**.
   The "Pending Promotions" item is removed from the user-menu dropdown.
7. **Admin hub layout:** left sidebar (Users / Promotions sections).
8. **Role-edit UX:** changing a user's role dropdown commits immediately (PATCH
   + toast); no confirm dialog.

## Data model

`prisma/schema.prisma`:

```prisma
enum Role {
  ADMIN
  DEVELOPER
  DEFAULT_USER
}

model User {
  // ...
  role Role @default(DEFAULT_USER)
  // `roles UserRole[]` removed
}

// model UserRole and its @@map("user_roles") table are dropped
```

**Migration** (`pnpm db:migrate` — never hand-edit the SQL):
1. Add the `Role` enum's new values / new enum; add `User.role` defaulting to
   `DEFAULT_USER`.
2. Backfill: users with an `admin` `UserRole` row → `ADMIN`; **all other
   existing users → `DEVELOPER`** (they already have edit+launch behavior
   today; do not silently demote them).
3. Drop the `user_roles` table and the legacy lowercase `admin` enum value.

## Session shape

`lib/services/types.ts`:

```ts
export type SessionUser = {
  // ...
  role: Role;        // 'ADMIN' | 'DEVELOPER' | 'DEFAULT_USER'
  isAdmin: boolean;  // === (role === 'ADMIN') — keeps existing call sites working
};
```

`getSessionUserById` (and the by-email / by-token paths that delegate to it)
read `user.role` directly instead of scanning role rows, and derive `isAdmin`
from it. The ~15 existing `isAdmin` call sites (ACL, promotions services,
preview-proxy, dashboard) continue to work untouched.

## Access-control helper

`lib/acl.ts` gains:

```ts
export function canEdit(user: SessionUser): boolean {
  return user.role === 'ADMIN' || user.role === 'DEVELOPER';
}
```

Used by page guards and the Topbar. `canReadForge`, `canWriteForge`, and
`forgeReadFilter` are unchanged.

## Enforcement

There is no `middleware.ts`; auth is enforced per-page in server components
(the `(app)/layout.tsx` redirect, `promotions/page.tsx`'s
`if (!isAdmin) redirect(...)`). We follow that pattern.

**DEFAULT_USER gating (edit surface):**
- `app/(app)/dashboard/page.tsx` → `if (!canEdit(session.user)) redirect('/launch')`.
- `app/(app)/forges/[id]/page.tsx` → same guard.
- Forge write-path API routes (create/update forge, runtime start/stop) add an
  explicit `canEdit` check as defense-in-depth. (The service layer already
  throws `ForbiddenError` for non-owners; this makes the role boundary
  server-enforced, not UI-only.)

**Landing:** a DEFAULT_USER logging in lands on `/launch` (root / post-login
navigation points there for that role; ADMIN/DEVELOPER land where they do
today).

**Nav (`components/topbar/Topbar.tsx`):**
- **Edit** link shown only when `canEdit(user)`.
- **Launch** link + UserMenu shown for everyone.
- **Admin** link shown only when `user.isAdmin`.
- Resulting header: DEFAULT_USER `[LAUNCH]`; DEVELOPER `[EDIT] [LAUNCH]`;
  ADMIN `[EDIT] [LAUNCH] [ADMIN]`.

**UserMenu (`components/topbar/UserMenu.tsx`):** the "Pending Promotions" item
and its admin block are removed. The dropdown returns to Account + Logout.

## Admin section

A new `/admin` section, admin-guarded once at the layout, with a left-sidebar
sub-nav:

- `app/(app)/admin/layout.tsx` — `if (!session.user.isAdmin) redirect('/dashboard')`
  (single choke point for the whole section); renders the left-sidebar nav
  (Users / Promotions) + `children`.
- `app/(app)/admin/page.tsx` — redirects to `/admin/users` (default section).
- `app/(app)/admin/users/page.tsx` — role management (`AdminUsersClient`).
- `app/(app)/admin/promotions/page.tsx` — renders the **existing**
  `PromotionsClient`, moved here. Its data still comes from the current
  promotion API routes and services, which are **unchanged**.
- **`app/(app)/promotions/` is removed.** Its only inbound link was the
  now-deleted UserMenu item.

### Users management

- **Service** (`lib/services/users.ts`):
  - `listUsersForAdmin(currentUser)` → `{ id, name, email, role }[]`. Throws
    `ForbiddenError('Admin only')` if `!currentUser.isAdmin`.
  - `setUserRole(currentUser, targetUserId, role)` → updates `User.role`.
    Throws `ForbiddenError('Admin only')` if `!currentUser.isAdmin`; rejects an
    admin changing **their own** role (avoids locking out the last admin);
    rejects an unknown role value.
- **API:** `app/api/admin/users/[id]/role/route.ts` (PATCH) → `setUserRole`.
- **Client (`AdminUsersClient`):** a table (existing shadcn `table`) of users
  with a role `select` (three values) per row. Changing the select PATCHes
  immediately and shows a `sonner` toast on success/error. No search or
  pagination this iteration (pilot scale). The current user's own row shows the
  role but the select is disabled (self-demotion guard, surfaced in the UI).

## Seed

`prisma/seed.ts`:
- Platform admin seeds as `role: 'ADMIN'`.
- Add a sample `DEVELOPER` and a sample `DEFAULT_USER` account so all three
  tiers are exercisable locally.
- Remove `userRole.deleteMany()` / `userRole.create(...)` usage in favor of the
  `role` column.

## Testing

- `lib/acl.test.ts` — `canEdit` for all three roles; confirm DEFAULT_USER read
  scope collapses to group-only (owned clause never fires).
- `lib/services/users.test.ts` — `getSessionUserById` maps the `role` column
  and derives `isAdmin`; `setUserRole` enforces admin-only, rejects
  self-demotion, rejects unknown role; `listUsersForAdmin` enforces admin-only.
- Page-guard tests: `dashboard` and `forges/[id]` redirect a DEFAULT_USER to
  `/launch`; `admin/layout` redirects non-admins.
- `Topbar` test — Edit hidden for DEFAULT_USER; Admin shown only for admin;
  resulting link set per role.
- `AdminUsersClient` — renders users, role change PATCHes + toasts, own-row
  select disabled.

## Out of scope

- Search / filter / pagination on the users table (YAGNI at pilot scale).
- Per-forge or per-group roles (roles remain global to the user).
- Confirmation dialogs / undo on role change (immediate commit by decision 8).
- Changing DEVELOPER's forge read/write scope (unchanged from today).
