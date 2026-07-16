# User Roles: DEVELOPER & DEFAULT_USER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-tier admin/regular-user model with three explicit roles — `ADMIN`, `DEVELOPER`, `DEFAULT_USER` — and add an admin `/admin` section for user-role and promotion management.

**Architecture:** Roles become a single `role` column on `User` (replacing the `UserRole` join table). `SessionUser` carries the `role` plus a derived `isAdmin` so existing call sites keep working. A new `canEdit()` ACL helper gates the edit surface; DEFAULT_USER is redirected off `/dashboard` and `/forges/[id]` to `/launch`. A new `/admin` section (left-sidebar hub) hosts user-role management and the relocated promotions page.

**Tech Stack:** Next.js 16 (App Router, server components), React 19, Prisma 7 + Postgres 16, Vitest, shadcn (Base UI), Tailwind v4, sonner toasts.

## Global Constraints

- **Next.js 16 APIs differ from training data** — read `node_modules/next/dist/docs/` before writing route/page code; heed deprecations. (from AGENTS.md)
- **Octokit only inside `lib/github/`** — not touched here, but never import it elsewhere.
- **DB access via `lib/prisma.ts`**; Postgres host port is `5433`.
- **Never hand-edit schema DDL in migrations** — generate with `pnpm db:migrate`. The one allowed manual addition is the **data backfill** in Task 1 (Prisma cannot infer it); insert only the `UPDATE` statements shown, leave generated DDL untouched.
- **Tests colocated** as `*.test.ts(x)`; unit suite is `pnpm test`, typecheck is `pnpm typecheck`.
- **Error classes** live in `@/lib/errors` (`ForbiddenError`, `ValidationError`, `NotFoundError`). API routes convert them via `respondToServiceError` from `@/lib/http`.
- **Do NOT run `pnpm db:reset` or `forge-launch.sh --seed`** — destructive. Local migration is `pnpm db:migrate`.
- Enum values are UPPER_SNAKE: `ADMIN`, `DEVELOPER`, `DEFAULT_USER`. New-user default is `DEFAULT_USER`.

---

### Task 1: Schema — `role` column + migration + backfill

**Files:**
- Modify: `prisma/schema.prisma:11-33` (User model), `:58-71` (Role enum + UserRole model)
- Modify: generated migration under `prisma/migrations/<timestamp>_user_roles/migration.sql` (data backfill only)

**Interfaces:**
- Produces: `User.role` column of type `Role` (`'ADMIN' | 'DEVELOPER' | 'DEFAULT_USER'`), default `DEFAULT_USER`; the `UserRole` model / `user_roles` table are removed. Prisma client regenerated with the new `Role` enum.

- [ ] **Step 1: Edit the enum** in `prisma/schema.prisma` — replace

```prisma
enum Role {
  admin
}
```

with

```prisma
enum Role {
  ADMIN
  DEVELOPER
  DEFAULT_USER
}
```

- [ ] **Step 2: Add the column to `User`, remove the join relation.** In `model User`, delete the line `roles         UserRole[]` and add (next to `initials`/timestamps):

```prisma
  role      Role     @default(DEFAULT_USER)
```

- [ ] **Step 3: Delete the `UserRole` model entirely** (the whole `model UserRole { ... @@map("user_roles") }` block, lines ~62-71).

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:migrate --name user_roles`
Expected: Prisma creates `prisma/migrations/<timestamp>_user_roles/migration.sql`. Because the `Role` enum changes while in use, Prisma emits a shadow-type swap (`CREATE TYPE "Role_new" ...`). The generated SQL adds `users.role` with default `DEFAULT_USER` and drops `user_roles` — but does **not** preserve who was an admin.

- [ ] **Step 5: Insert the data backfill** into the generated `migration.sql`, immediately **before** the `DROP TABLE "user_roles"` statement (so the old rows are still readable):

```sql
-- Backfill roles from the old user_roles table before it is dropped.
UPDATE "users" SET "role" = 'ADMIN'
  WHERE "id" IN (SELECT "user_id" FROM "user_roles" WHERE "role"::text = 'admin');
UPDATE "users" SET "role" = 'DEVELOPER'
  WHERE "id" NOT IN (SELECT "user_id" FROM "user_roles" WHERE "role"::text = 'admin');
```

Note: existing non-admins become `DEVELOPER` (they already have edit+launch today — do not demote). The `DEFAULT_USER` default applies only to users created *after* this migration.

- [ ] **Step 6: Apply the edited migration**

Run: `pnpm db:migrate` (re-runs `prisma migrate dev`, applies the pending migration)
Expected: "Database schema is up to date", Prisma client regenerated. No error.

- [ ] **Step 7: Typecheck to confirm the client regenerated**

Run: `pnpm typecheck`
Expected: FAILS — remaining references to `prisma.userRole` and `user.roles` (in `users.ts`, `seed.ts`, `lib/test/db.ts`) now error. This is expected; later tasks fix them. Confirm the *only* errors are about `userRole`/`roles`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(auth): add User.role column, drop user_roles join table"
```

---

### Task 2: `SessionUser.role` + users service reads the column

**Files:**
- Modify: `lib/services/types.ts:3-11` (SessionUser)
- Modify: `lib/services/users.ts:38-56` (getSessionUserById)
- Modify: `lib/test/db.ts:48-84` (makeUser), `:32-46` (withCleanDb)
- Test: `lib/services/users.test.ts`

**Interfaces:**
- Consumes: `User.role` (Task 1).
- Produces: `SessionUser` now has `role: Role` and `isAdmin: boolean` (derived). `makeUser(prisma, { ..., role?: Role })` test helper sets `role` (defaulting to `'DEVELOPER'` so existing forge/ACL tests that assume edit-capable non-admins keep passing).

- [ ] **Step 1: Update the `SessionUser` type.** In `lib/services/types.ts`, add the import and field:

```ts
import type { ForgeTone, MessageRole, Role } from '@prisma/client';

export type SessionUser = {
  id: string;
  entraOid: string | null;
  email: string;
  name: string;
  initials: string;
  groups: string[];
  role: Role;
  isAdmin: boolean;
};
```

- [ ] **Step 2: Update `getSessionUserById`.** In `lib/services/users.ts`, change the `include` and the returned object:

```ts
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      groups: { include: { group: true } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    entraOid: user.entraOid,
    email: user.email,
    name: user.name,
    initials: user.initials,
    groups: user.groups.map((ug) => ug.group.name),
    role: user.role,
    isAdmin: user.role === 'ADMIN',
  };
```

(Remove the `roles: true` include and the `user.roles.some(...)` expression.)

- [ ] **Step 3: Update the `makeUser` test helper.** In `lib/test/db.ts`, replace the `isAdmin` handling with a `role` param:

```ts
export async function makeUser(
  prisma: PrismaClient,
  data: {
    email: string;
    name: string;
    groups?: string[];
    role?: Role;
  },
): Promise<SessionUser> {
  const initials = data.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const role = data.role ?? 'DEVELOPER';
  const user = await prisma.user.create({
    data: { email: data.email, name: data.name, initials, role },
  });
  for (const name of data.groups ?? []) {
    const group =
      (await prisma.group.findUnique({ where: { name } })) ??
      (await prisma.group.create({ data: { name } }));
    await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
  }
  return {
    id: user.id,
    entraOid: null,
    email: user.email,
    name: user.name,
    initials: user.initials,
    groups: data.groups ?? [],
    role,
    isAdmin: role === 'ADMIN',
  };
}
```

Add `Role` to the imports at the top: `import { PrismaClient, type Role } from '@prisma/client';`

- [ ] **Step 4: Fix `withCleanDb`.** In `lib/test/db.ts`, delete the line `await prisma.userRole.deleteMany();` (the table no longer exists).

- [ ] **Step 5: Migrate the `makeUser` ripple sites.** Changing `makeUser`'s param from `isAdmin` to `role` breaks every caller that passed `isAdmin: true`. Replace `isAdmin: true` with `role: 'ADMIN'` in these exact `makeUser(...)` calls (non-admin callers pass nothing and default to `DEVELOPER` — leave them):
  - `lib/services/forges.test.ts` lines 23, 40, 205, 385, 444, 474 — each `..., groups: [], isAdmin: true }` → `..., groups: [], role: 'ADMIN' }`
  - `lib/services/promotions.test.ts` line 124 — same replacement.

  Then fix the two `SessionUser` **literals** in `lib/runtime/preview-proxy.test.ts` (lines ~9 and ~128) — add `role: 'DEVELOPER'` next to `isAdmin: false` so the literals satisfy the updated type:

```ts
  groups: ['eng'], isAdmin: false, role: 'DEVELOPER',
```

  Verify none remain: `grep -rn "isAdmin: true" lib/services/forges.test.ts lib/services/promotions.test.ts` → no output.

- [ ] **Step 6: Update the users test.** In `lib/services/users.test.ts`, replace the "returns the user with groups[] and isAdmin populated" test body's role setup and assertions:

```ts
  it('returns the user with groups[], role and isAdmin populated', async () => {
    await withCleanDb(async (prisma) => {
      const user = await prisma.user.create({
        data: { email: 'maya@x.com', name: 'Maya', initials: 'M', role: 'ADMIN' },
      });
      const eng = await prisma.group.create({ data: { name: 'Engineering' } });
      await prisma.userGroup.create({ data: { userId: user.id, groupId: eng.id } });

      const session = await getSessionUserById(user.id);
      expect(session?.groups).toEqual(['Engineering']);
      expect(session?.role).toBe('ADMIN');
      expect(session?.isAdmin).toBe(true);
    });
  });

  it('defaults a plain user to DEFAULT_USER / non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const user = await prisma.user.create({
        data: { email: 'plain@x.com', name: 'Plain', initials: 'P' },
      });
      const session = await getSessionUserById(user.id);
      expect(session?.role).toBe('DEFAULT_USER');
      expect(session?.isAdmin).toBe(false);
    });
  });
```

- [ ] **Step 7: Run the affected suites**

Run: `pnpm test lib/services/users.test.ts lib/services/forges.test.ts lib/services/promotions.test.ts lib/runtime/preview-proxy.test.ts`
Expected: PASS (all cases — the ripple sites now compile and behave as before).

- [ ] **Step 8: Commit**

```bash
git add lib/services/types.ts lib/services/users.ts lib/test/db.ts \
  lib/services/users.test.ts lib/services/forges.test.ts \
  lib/services/promotions.test.ts lib/runtime/preview-proxy.test.ts
git commit -m "feat(auth): SessionUser.role read from column, derive isAdmin"
```

---

### Task 3: `canEdit` ACL helper

**Files:**
- Modify: `lib/acl.ts`
- Test: `lib/acl.test.ts`

**Interfaces:**
- Consumes: `SessionUser.role` (Task 2).
- Produces: `canEdit(user: SessionUser): boolean` — `true` for `ADMIN`/`DEVELOPER`, `false` for `DEFAULT_USER`.

- [ ] **Step 1: Write the failing test.** Append to `lib/acl.test.ts`:

```ts
import { canEdit } from './acl';

describe('canEdit', () => {
  const base = { id: 'u', entraOid: null, email: 'e', name: 'n', initials: 'N', groups: [] };
  it('allows ADMIN', () => {
    expect(canEdit({ ...base, role: 'ADMIN', isAdmin: true })).toBe(true);
  });
  it('allows DEVELOPER', () => {
    expect(canEdit({ ...base, role: 'DEVELOPER', isAdmin: false })).toBe(true);
  });
  it('denies DEFAULT_USER', () => {
    expect(canEdit({ ...base, role: 'DEFAULT_USER', isAdmin: false })).toBe(false);
  });
});
```

Also update the three existing `SessionUser` fixtures at the top of the file (`member`, `stranger`, `admin`) to include a `role`: add `role: 'DEVELOPER'` to `member` and `stranger`, and `role: 'ADMIN'` to `admin` (keeps them type-valid).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/acl.test.ts`
Expected: FAIL — `canEdit is not a function` / import error.

- [ ] **Step 3: Implement `canEdit`.** Add to `lib/acl.ts`:

```ts
/** True when the user may reach the edit surface (create/edit forges, runtimes). */
export function canEdit(user: SessionUser): boolean {
  return user.role === 'ADMIN' || user.role === 'DEVELOPER';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/acl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/acl.ts lib/acl.test.ts
git commit -m "feat(auth): add canEdit ACL helper"
```

---

### Task 4: Server-enforce edit boundary in `createForge`

**Files:**
- Modify: `lib/services/forges.ts:1-12` (imports), `:170-175` (createForge)
- Test: `lib/services/forges.test.ts`

**Interfaces:**
- Consumes: `canEdit` (Task 3).
- Produces: `createForge` throws `ForbiddenError` for a `DEFAULT_USER`. (Runtime start/stop and forge update are already gated by `canWriteForge` ownership, which a DEFAULT_USER can never satisfy — no change needed there.)

- [ ] **Step 1: Write the failing test.** Add to `lib/services/forges.test.ts` (follow the file's existing `withCleanDb`/`makeUser` pattern; use the fake GitHub client already wired in that suite):

```ts
it('rejects forge creation by a DEFAULT_USER', async () => {
  await withCleanDb(async (prisma) => {
    const consumer = await makeUser(prisma, {
      email: 'consumer@x.com', name: 'Con Sumer', groups: ['Engineering'], role: 'DEFAULT_USER',
    });
    await expect(
      createForge(consumer, { name: 'Nope', description: '', tone: 'navy', groups: ['Engineering'] }),
    ).rejects.toThrow(ForbiddenError);
  });
});
```

Ensure the test file imports `ForbiddenError` from `@/lib/errors` and `createForge` from `./forges` (add if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/services/forges.test.ts -t "DEFAULT_USER"`
Expected: FAIL — createForge currently succeeds (no role gate).

- [ ] **Step 3: Add the guard.** In `lib/services/forges.ts`, import `canEdit`:

```ts
import { canEdit, canReadForge, canWriteForge, forgeReadFilter, toAcl } from '@/lib/acl';
```

Then as the first statement inside `createForge` (before the name-uniqueness pre-check):

```ts
  if (!canEdit(currentUser)) {
    throw new ForbiddenError('Your role cannot create forges');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/services/forges.test.ts -t "DEFAULT_USER"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(auth): block DEFAULT_USER from creating forges"
```

---

### Task 5: Route guards + landing redirect for DEFAULT_USER

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`, `app/(app)/forges/[id]/page.tsx`
- Modify: `app/page.tsx`, `app/(auth)/login/LoginPanel.tsx:14,26`

**Interfaces:**
- Consumes: `canEdit` (Task 3), `SessionUser.role`.
- Produces: `/dashboard` and `/forges/[id]` redirect a DEFAULT_USER to `/launch`; root and post-login route a DEFAULT_USER to `/launch`, others to `/dashboard`.

- [ ] **Step 1: Guard the dashboard page.** In `app/(app)/dashboard/page.tsx`, add `canEdit` import and guard right after the session check:

```ts
import { canEdit } from '@/lib/acl';
// ...
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!canEdit(session.user)) redirect('/launch');
```

- [ ] **Step 2: Guard the forge detail page.** In `app/(app)/forges/[id]/page.tsx`, after `if (!session?.user) redirect('/login');`:

```ts
import { canEdit } from '@/lib/acl';
// ...
  if (!canEdit(session.user)) redirect('/launch');
```

- [ ] **Step 3: Route the root page by role.** Replace `app/page.tsx` body so it resolves the session and lands DEFAULT_USER on `/launch`:

```ts
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { canEdit } from '@/lib/acl';

export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect(canEdit(session.user) ? '/dashboard' : '/launch');
}
```

(If `app/page.tsx` has other markup, keep it minimal — this is a pure redirect page today.)

- [ ] **Step 4: Point post-login at the root router.** In `app/(auth)/login/LoginPanel.tsx`, change both `'/dashboard'` occurrences (lines 14 and 26) to `'/'` so the role-aware root page decides the destination:

```ts
await signIn('microsoft-entra-id', { callbackUrl: '/' });
// ...
window.location.href = '/';
```

- [ ] **Step 5: Verify build/typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 6: Manually verify the redirect** (fake mode, dev users enabled). Start dev server, use the dev user switcher to become a DEFAULT_USER, visit `/dashboard`.
Expected: redirected to `/launch`. As a DEVELOPER/ADMIN, `/dashboard` loads normally.

- [ ] **Step 7: Commit**

```bash
git add app/\(app\)/dashboard/page.tsx app/\(app\)/forges/\[id\]/page.tsx app/page.tsx app/\(auth\)/login/LoginPanel.tsx
git commit -m "feat(auth): gate edit surface + role-aware landing for DEFAULT_USER"
```

---

### Task 6: Role-aware Topbar nav

**Files:**
- Modify: `components/topbar/Topbar.tsx`
- Test: `components/topbar/Topbar.test.tsx`

**Interfaces:**
- Consumes: `canEdit` (Task 3), `SessionUser.role`/`isAdmin`.
- Produces: Topbar renders **Edit** only when `canEdit(user)`, **Launch** always, **Admin** (→ `/admin`) only when `user.isAdmin`.

- [ ] **Step 1: Write the failing tests.** In `components/topbar/Topbar.test.tsx`, add `role` to the existing `user` fixture (`role: 'DEVELOPER'`), and add:

```ts
const defaultUser = { ...user, role: 'DEFAULT_USER' as const, isAdmin: false };
const adminUser = { ...user, role: 'ADMIN' as const, isAdmin: true };

it('hides the Edit link for a DEFAULT_USER', () => {
  render(<Topbar user={defaultUser} />);
  expect(screen.queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /launch/i })).toBeInTheDocument();
});

it('shows the Admin link only for admins', () => {
  const { rerender } = render(<Topbar user={user} />);
  expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  rerender(<Topbar user={adminUser} />);
  const link = screen.getByRole('link', { name: /admin/i });
  expect(link).toHaveAttribute('href', '/admin');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test components/topbar/Topbar.test.tsx`
Expected: FAIL — Edit always renders; no Admin link exists.

- [ ] **Step 3: Implement role-aware nav.** In `components/topbar/Topbar.tsx`, import the helper and conditionally render:

```tsx
import { canEdit } from '@/lib/acl';
// ...
      <div className="flex items-center gap-6">
        {canEdit(user) && (
          <Link
            href="/dashboard"
            className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
          >
            Edit
          </Link>
        )}
        <Link
          href="/launch"
          className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
        >
          Launch
        </Link>
        {user.isAdmin && (
          <Link
            href="/admin"
            className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
          >
            Admin
          </Link>
        )}
        <UserMenu user={user} />
      </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test components/topbar/Topbar.test.tsx`
Expected: PASS (including the pre-existing Launch/Edit tests — the default fixture is a DEVELOPER so Edit still renders).

- [ ] **Step 5: Commit**

```bash
git add components/topbar/Topbar.tsx components/topbar/Topbar.test.tsx
git commit -m "feat(auth): role-aware Topbar (Edit/Launch/Admin)"
```

---

### Task 7: Remove "Pending Promotions" from the user menu

**Files:**
- Modify: `components/topbar/UserMenu.tsx`
- Test: `components/topbar/UserMenu.test.tsx`

**Interfaces:**
- Produces: `UserMenu` no longer renders a Promotions link (moved to `/admin`). Dropdown = Account group + Logout.

- [ ] **Step 1: Update the tests.** In `components/topbar/UserMenu.test.tsx`, replace the two promotions tests ("shows a Pending Promotions link to /promotions for admins" and "does not show ... for non-admins") with a single assertion that it never renders one:

```ts
it('does not render a Pending Promotions link (moved to /admin)', async () => {
  render(<UserMenu user={{ ...baseUser, isAdmin: true, role: 'ADMIN' }} />);
  // open the dropdown if the test util requires it (match the file's existing pattern)
  expect(screen.queryByText(/pending promotions/i)).not.toBeInTheDocument();
});
```

Add `role` to whatever user fixture the file defines (`role: 'DEVELOPER'` for the base). Keep the file's existing dropdown-opening interaction pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test components/topbar/UserMenu.test.tsx`
Expected: FAIL — the link still renders for admins.

- [ ] **Step 3: Remove the promotions block.** In `components/topbar/UserMenu.tsx`, delete the entire `{user.isAdmin && ( ... Pending Promotions ... )}` block (lines ~39-48) and the now-unused imports (`Link`, `ShieldCheck`, `DropdownMenuLinkItem` if unused elsewhere — verify before removing each).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test components/topbar/UserMenu.test.tsx && pnpm typecheck`
Expected: PASS; no unused-import lint errors.

- [ ] **Step 5: Commit**

```bash
git add components/topbar/UserMenu.tsx components/topbar/UserMenu.test.tsx
git commit -m "refactor(auth): drop Pending Promotions from user menu"
```

---

### Task 8: Admin users service — `listUsersForAdmin` + `setUserRole`

**Files:**
- Modify: `lib/services/users.ts`
- Test: `lib/services/users.test.ts`

**Interfaces:**
- Consumes: `SessionUser`, `Role`, `ForbiddenError`/`ValidationError` from `@/lib/errors`.
- Produces:
  - `listUsersForAdmin(currentUser: SessionUser): Promise<{ id: string; name: string; email: string; role: Role }[]>` — admin-only, ordered by name.
  - `setUserRole(currentUser: SessionUser, targetUserId: string, role: Role): Promise<{ id: string; role: Role }>` — admin-only; rejects self-change; rejects unknown role; throws `NotFoundError` for unknown user.

- [ ] **Step 1: Write the failing tests.** Add to `lib/services/users.test.ts`:

```ts
import { listUsersForAdmin, setUserRole } from './users';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors';

describe('admin user management', () => {
  it('listUsersForAdmin returns users for an admin, ordered by name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Zed Admin', role: 'ADMIN' });
      await makeUser(prisma, { email: 'b@x.com', name: 'Amy Dev', role: 'DEVELOPER' });
      const rows = await listUsersForAdmin(admin);
      expect(rows.map((r) => r.name)).toEqual(['Amy Dev', 'Zed Admin']);
      expect(rows.find((r) => r.email === 'b@x.com')?.role).toBe('DEVELOPER');
    });
  });

  it('listUsersForAdmin rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listUsersForAdmin(dev)).rejects.toThrow(ForbiddenError);
    });
  });

  it('setUserRole updates a target user', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const target = await makeUser(prisma, { email: 't@x.com', name: 'Target', role: 'DEFAULT_USER' });
      const res = await setUserRole(admin, target.id, 'DEVELOPER');
      expect(res.role).toBe('DEVELOPER');
      const reread = await getSessionUserById(target.id);
      expect(reread?.role).toBe('DEVELOPER');
    });
  });

  it('setUserRole rejects a non-admin caller', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const target = await makeUser(prisma, { email: 't@x.com', name: 'T', role: 'DEFAULT_USER' });
      await expect(setUserRole(dev, target.id, 'ADMIN')).rejects.toThrow(ForbiddenError);
    });
  });

  it('setUserRole forbids changing your own role', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(setUserRole(admin, admin.id, 'DEVELOPER')).rejects.toThrow(ForbiddenError);
    });
  });

  it('setUserRole rejects an unknown role value', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const target = await makeUser(prisma, { email: 't@x.com', name: 'T', role: 'DEFAULT_USER' });
      // @ts-expect-error deliberately invalid role
      await expect(setUserRole(admin, target.id, 'SUPERUSER')).rejects.toThrow(ValidationError);
    });
  });

  it('setUserRole throws NotFoundError for unknown user', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(
        setUserRole(admin, '00000000-0000-0000-0000-000000000000', 'DEVELOPER'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test lib/services/users.test.ts -t "admin user management"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the service functions.** Add to `lib/services/users.ts` (add imports for the error classes and `Role`):

```ts
import { Role } from '@prisma/client';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

const ROLE_VALUES: Role[] = ['ADMIN', 'DEVELOPER', 'DEFAULT_USER'];

export async function listUsersForAdmin(
  currentUser: SessionUser,
): Promise<{ id: string; name: string; email: string; role: Role }[]> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  return prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true },
  });
}

export async function setUserRole(
  currentUser: SessionUser,
  targetUserId: string,
  role: Role,
): Promise<{ id: string; role: Role }> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  if (targetUserId === currentUser.id) {
    throw new ForbiddenError('You cannot change your own role');
  }
  if (!ROLE_VALUES.includes(role)) {
    throw new ValidationError('Unknown role', { role: [`Must be one of ${ROLE_VALUES.join(', ')}`] });
  }
  const existing = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!existing) throw new NotFoundError(`User ${targetUserId} not found`);
  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role },
    select: { id: true, role: true },
  });
  return updated;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test lib/services/users.test.ts -t "admin user management"`
Expected: PASS (all seven cases).

- [ ] **Step 5: Commit**

```bash
git add lib/services/users.ts lib/services/users.test.ts
git commit -m "feat(admin): listUsersForAdmin + setUserRole service"
```

---

### Task 9: Admin role API route

**Files:**
- Create: `app/api/admin/users/[id]/role/route.ts`

**Interfaces:**
- Consumes: `setUserRole` (Task 8), `respondToServiceError` (`@/lib/http`), `auth` (`@/lib/auth`).
- Produces: `PATCH /api/admin/users/[id]/role` with body `{ role: Role }` → `{ user: { id, role } }`.

- [ ] **Step 1: Read the Next.js route-handler docs** for the params/context signature.

Run: `ls node_modules/next/dist/docs/ && grep -rl "route handler\|RouteContext\|params" node_modules/next/dist/docs/ | head`
Then read the relevant file. Confirm the `ctx.params` await pattern (matches `app/api/promotions/[id]/accept/route.ts`).

- [ ] **Step 2: Create the route.**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { setUserRole } from '@/lib/services/users';
import { respondToServiceError } from '@/lib/http';

const Body = z.object({ role: z.enum(['ADMIN', 'DEVELOPER', 'DEFAULT_USER']) });

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/admin/users/[id]/role'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { id } = await ctx.params;
  try {
    const user = await setUserRole(session.user, id, parsed.data.role);
    return NextResponse.json({ user });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (If `RouteContext<...>` generic differs in this Next version, mirror exactly what `app/api/promotions/[id]/accept/route.ts` uses.)

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/users/\[id\]/role/route.ts
git commit -m "feat(admin): PATCH /api/admin/users/[id]/role"
```

---

### Task 10: `/admin` section shell — layout, sidebar, promotions move

**Files:**
- Create: `app/(app)/admin/layout.tsx`, `app/(app)/admin/page.tsx`, `app/(app)/admin/AdminNav.tsx`, `app/(app)/admin/promotions/page.tsx`
- Move: `app/(app)/promotions/PromotionsClient.tsx` → `app/(app)/admin/promotions/PromotionsClient.tsx` (and its test)
- Delete: `app/(app)/promotions/` (old dir) — **requires the confirmation below before deleting**

**Interfaces:**
- Consumes: `auth`, `SessionUser.isAdmin`.
- Produces: `/admin` (redirect → `/admin/users`), `/admin/promotions` (existing PromotionsClient), left-sidebar `AdminNav` linking Users + Promotions. Task 11 adds `/admin/users`.

- [ ] **Step 1: Create the admin layout** (`app/(app)/admin/layout.tsx`) — single admin guard + sidebar shell:

```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AdminNav } from './AdminNav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!session.user.isAdmin) redirect('/dashboard');
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 px-8 py-8">
      <AdminNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Create the sidebar nav** (`app/(app)/admin/AdminNav.tsx`) — client component using `usePathname` for the active state, matching the app's panel styling:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/promotions', label: 'Promotions' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <aside className="w-44 shrink-0">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">Admin</div>
      <nav className="flex flex-col gap-1">
        {ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm transition ${
                active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 3: Create `/admin` index redirect** (`app/(app)/admin/page.tsx`):

```tsx
import { redirect } from 'next/navigation';

export default function AdminIndexPage() {
  redirect('/admin/users');
}
```

- [ ] **Step 4: Move the promotions client.** Copy `app/(app)/promotions/PromotionsClient.tsx` to `app/(app)/admin/promotions/PromotionsClient.tsx` unchanged (it fetches `/api/promotions` — API unchanged). Copy its test file too if one exists (`PromotionsClient.test.tsx`).

- [ ] **Step 5: Create `/admin/promotions` page** (`app/(app)/admin/promotions/page.tsx`) — the admin guard now lives in the layout, so this is thin:

```tsx
import { PromotionsClient } from './PromotionsClient';

export const dynamic = 'force-dynamic';

export default function AdminPromotionsPage() {
  return <PromotionsClient />;
}
```

- [ ] **Step 6: CONFIRM DELETION, then remove the old promotions route.** Per org policy ("never delete files without asking permission first") and CLAUDE.md, **ask the user to confirm** removing `app/(app)/promotions/` before deleting. On approval:

```bash
git rm -r app/\(app\)/promotions
```

Then grep for stragglers: `grep -rn "app/(app)/promotions\|from '@/app/(app)/promotions" app components lib` — expected: no results (the UserMenu link was removed in Task 7).

- [ ] **Step 7: Typecheck + build the route tree**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/\(app\)/admin
git commit -m "feat(admin): /admin section shell + relocate promotions page"
```

---

### Task 11: Admin Users page + `AdminUsersClient`

**Files:**
- Create: `app/(app)/admin/users/page.tsx`, `app/(app)/admin/users/AdminUsersClient.tsx`
- Test: `app/(app)/admin/users/AdminUsersClient.test.tsx`

**Interfaces:**
- Consumes: `listUsersForAdmin` (Task 8), the PATCH route (Task 9), `SessionUser.id` (to disable own row), shadcn `Select` + `sonner` `toast`.
- Produces: `/admin/users` — table of users with a per-row role dropdown; changing it PATCHes immediately and toasts; the current user's own select is disabled.

- [ ] **Step 1: Create the server page** (`app/(app)/admin/users/page.tsx`) — loads users and passes the current user id:

```tsx
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listUsersForAdmin } from '@/lib/services/users';
import { AdminUsersClient } from './AdminUsersClient';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login'); // layout already guards admin
  const users = await listUsersForAdmin(session.user);
  return <AdminUsersClient users={users} currentUserId={session.user.id} />;
}
```

- [ ] **Step 2: Confirm the Select primitive.** 

Run: `ls components/ui/ | grep -i select`
If `select.tsx` exists, use it. If not, use a native `<select>` styled with the app's input classes (check `components/ui/` for the pattern). The steps below assume `components/ui/select` exports `Select, SelectTrigger, SelectValue, SelectContent, SelectItem`; adapt to the actual exports.

- [ ] **Step 3: Write the client component** (`app/(app)/admin/users/AdminUsersClient.tsx`):

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { Role } from '@prisma/client';

type Row = { id: string; name: string; email: string; role: Role };
const ROLES: Role[] = ['ADMIN', 'DEVELOPER', 'DEFAULT_USER'];
const LABEL: Record<Role, string> = { ADMIN: 'Admin', DEVELOPER: 'Developer', DEFAULT_USER: 'Default User' };

export function AdminUsersClient({ users, currentUserId }: { users: Row[]; currentUserId: string }) {
  const [rows, setRows] = useState(users);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function changeRole(id: string, role: Role) {
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, role } : r)));
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to update role');
      }
      toast.success('Role updated');
    } catch (err) {
      setRows(prev); // revert optimistic update
      toast.error(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Users</h1>
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-ink-dim">
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Email</th>
            <th className="py-2 font-medium">Role</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const isSelf = u.id === currentUserId;
            return (
              <tr key={u.id} className="border-b border-border/60">
                <td className="py-3">{u.name}</td>
                <td className="py-3 text-ink-dim">{u.email}</td>
                <td className="py-3">
                  <select
                    aria-label={`Role for ${u.name}`}
                    value={u.role}
                    disabled={isSelf || busyId === u.id}
                    onChange={(e) => changeRole(u.id, e.target.value as Role)}
                    className="rounded-md border border-border bg-panel px-2 py-1 text-sm text-ink disabled:opacity-50"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{LABEL[r]}</option>
                    ))}
                  </select>
                  {isSelf && <span className="ml-2 text-[11px] text-ink-faint">(you)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

(Use the native `<select>` shown here — it needs no extra primitive and gives the tests a stable `aria-label` combobox. Swap to the shadcn `Select` only if the reviewer prefers it; the interaction contract stays the same.)

- [ ] **Step 4: Write the client test** (`app/(app)/admin/users/AdminUsersClient.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminUsersClient } from './AdminUsersClient';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const users = [
  { id: 'u1', name: 'Amy Dev', email: 'amy@x.com', role: 'DEVELOPER' as const },
  { id: 'me', name: 'Me Admin', email: 'me@x.com', role: 'ADMIN' as const },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AdminUsersClient', () => {
  it('renders a row per user', () => {
    render(<AdminUsersClient users={users} currentUserId="me" />);
    expect(screen.getByText('Amy Dev')).toBeInTheDocument();
    expect(screen.getByText('me@x.com')).toBeInTheDocument();
  });

  it("disables the current user's own role select", () => {
    render(<AdminUsersClient users={users} currentUserId="me" />);
    expect(screen.getByLabelText('Role for Me Admin')).toBeDisabled();
    expect(screen.getByLabelText('Role for Amy Dev')).not.toBeDisabled();
  });

  it('PATCHes and toasts on role change', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const { toast } = await import('sonner');

    render(<AdminUsersClient users={users} currentUserId="me" />);
    fireEvent.change(screen.getByLabelText('Role for Amy Dev'), { target: { value: 'ADMIN' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users/u1/role',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('reverts and toasts error on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    vi.stubGlobal('fetch', fetchMock);
    const { toast } = await import('sonner');

    render(<AdminUsersClient users={users} currentUserId="me" />);
    const select = screen.getByLabelText('Role for Amy Dev') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ADMIN' } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    await waitFor(() => expect(select.value).toBe('DEVELOPER')); // reverted
  });
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm test app/\(app\)/admin/users/AdminUsersClient.test.tsx`
Expected: PASS (all four cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/\(app\)/admin/users
git commit -m "feat(admin): users role-management page"
```

---

### Task 12: Seed all three roles

**Files:**
- Modify: `prisma/seed.ts:30-35` (USERS), `:150` (reset), `:163-179` (user creation)

**Interfaces:**
- Consumes: `User.role` column.
- Produces: seed creates one ADMIN, existing sample users as DEVELOPER, plus one DEFAULT_USER — so all three tiers are exercisable locally.

- [ ] **Step 1: Update the USERS list.** In `prisma/seed.ts`, give each entry an explicit `role` and add a DEFAULT_USER sample:

```ts
const USERS = [
  { email: 'maya.chen@crystalfountains.com',  name: 'Maya Chen',   initials: 'MC', groups: ['Engineering', 'R&D'], role: 'DEVELOPER' },
  { email: 'tom.reed@crystalfountains.com',   name: 'Tom Reed',    initials: 'TR', groups: ['Operations', 'Service'], role: 'DEVELOPER' },
  { email: 'alice.green@crystalfountains.com', name: 'Alice Green', initials: 'AG', groups: ['Marketing'], role: 'DEVELOPER' },
  { email: 'sam.viewer@crystalfountains.com', name: 'Sam Viewer',  initials: 'SV', groups: ['Marketing'], role: 'DEFAULT_USER' },
  { email: 'admin@crystalfountains.com',      name: 'Platform Admin', initials: 'PA', groups: [], role: 'ADMIN' },
] as const;
```

- [ ] **Step 2: Remove the userRole reset.** Delete `await prisma.userRole.deleteMany();` (line ~150) from `main()`'s reset block.

- [ ] **Step 3: Set role on create, drop the userRole.create branch.** In the user-seeding loop, change the create call and remove the admin branch:

```ts
      const user = await prisma.user.create({
        data: { email: u.email, name: u.name, initials: u.initials, role: u.role },
      });
      for (const groupName of u.groups) {
        const group = groupByName.get(groupName);
        if (!group) throw new Error(`Unknown group: ${groupName}`);
        await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
      }
      return user;
```

(Delete the `if ('isAdmin' in u && u.isAdmin) { await prisma.userRole.create(...) }` block.)

- [ ] **Step 4: Typecheck the seed**

Run: `pnpm typecheck`
Expected: PASS (no `userRole`/`isAdmin` references remain anywhere).

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(auth): seed ADMIN/DEVELOPER/DEFAULT_USER sample accounts"
```

---

### Task 13: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS — zero errors.

- [ ] **Step 2: Full unit suite**

Run: `pnpm test`
Expected: PASS — all suites green. Pay attention to `acl.test.ts`, `users.test.ts`, `forges.test.ts`, `Topbar.test.tsx`, `UserMenu.test.tsx`, `AdminUsersClient.test.tsx`.

- [ ] **Step 3: Lint** (catches unused imports from the UserMenu edit and the Octokit rule)

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Manual smoke** (fake mode + dev users; use the `/verify` skill for the driven check). As each seeded role:
  - **DEFAULT_USER** (`sam.viewer@`): header shows only `[LAUNCH]`; visiting `/dashboard`, `/forges/<id>`, `/admin` redirects (to `/launch` / `/dashboard` respectively); `/launch` shows running forges in the Marketing group.
  - **DEVELOPER** (`maya.chen@`): header `[EDIT] [LAUNCH]`; can create/edit/start forges; `/admin` redirects to `/dashboard`.
  - **ADMIN** (`admin@`): header `[EDIT] [LAUNCH] [ADMIN]`; `/admin` → Users list with role dropdowns (own row disabled) + Promotions tab; changing a user's role persists after reload.

- [ ] **Step 5: Final commit (if any manual fixes were needed)**

```bash
git add -A && git commit -m "test(auth): verify three-role model end-to-end"
```

---

## Notes for the implementer

- **Task order matters for typecheck.** Task 1 intentionally leaves the tree failing typecheck (dangling `userRole`/`roles` refs); Tasks 2 and 12 clear them. Don't "fix" those refs early in unrelated files — follow the task that owns each.
- **Enum + Postgres gotcha:** changing an in-use enum requires the shadow-type swap Prisma generates. The **only** manual edit to `migration.sql` is the two backfill `UPDATE`s in Task 1 Step 5 — do not rewrite the generated DDL.
- **Deletion gate:** Task 10 Step 6 (removing `app/(app)/promotions/`) must be confirmed with the user first, per the org policy — even though in-repo deletion is otherwise pre-approved for this codebase.
