# Phase 2: Dashboard CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add full Forge CRUD on the dashboard — search, status filter, create / edit metadata, delete with optimistic UI, all surfaced through shadcn modals + Sonner toasts and gated by service-layer ACL (creator OR admin).

**Architecture:** new mutating service functions extend `lib/services/forges.ts`; thin REST routes (`POST /api/forges`, `PATCH/DELETE /api/forges/:id`) validate with Zod and delegate to services; an error-mapping helper turns `AppError` subclasses into HTTP responses; the Server Component pre-fetches forges + groups and hands them to a new `DashboardClient` that owns search/filter/modal state and uses `react-hook-form` + Zod for client-side form validation.

**Tech Stack:** Next.js 16 (App Router), React 19, Prisma 7, Zod 4, react-hook-form, shadcn/ui (base-ui), Sonner, Vitest, Playwright.

---

## Spec references

- §6 "Component Architecture & REST API Surface" — REST table & sample shapes
- §7 "Phase Breakdown — Phase 2 — Dashboard CRUD" — scope and DoD
- §5 "Authentication & Authorisation" — service errors → HTTP map, ACL helpers (`canReadForge`, `canWriteForge`)

## Pre-flight checks

- [ ] **Step 1: Verify clean working tree on `main`**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: working tree clean, branch is `main`. If not clean, stop and resolve before proceeding.

- [ ] **Step 2: Verify Phase 1 still green**

```bash
docker compose ps
pnpm typecheck && pnpm lint && pnpm test
```

Expected: Postgres healthy; all three commands exit 0. (E2E is run later as part of Section E.)

- [ ] **Step 3: Branch off `main`**

```bash
git switch -c phase-2-dashboard-crud
```

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `lib/services/forges-schema.ts` | Zod schemas (`createForgeInput`, `updateForgeInput`) — shared by service, routes, client |
| `lib/services/groups.ts` | `listGroups()` — return all groups (id + name) |
| `lib/services/groups.test.ts` | Vitest TDD for `listGroups` |
| `lib/http.ts` | Pure helper `respondToServiceError(err)` — maps `AppError` → `NextResponse` |
| `lib/http.test.ts` | Vitest TDD for the mapper |
| `app/api/forges/route.ts` | `POST /api/forges` |
| `app/api/forges/[id]/route.ts` | `PATCH` and `DELETE /api/forges/:id` |
| `app/(app)/dashboard/DashboardClient.tsx` | Client: search, filter chips, modals, optimistic delete |
| `app/(app)/dashboard/ForgeFormModal.tsx` | Client: create + edit modal, RHF + Zod, group multi-select |
| `app/(app)/dashboard/ForgeFormModal.test.tsx` | Vitest TDD for the modal |
| `app/(app)/dashboard/DeleteConfirmDialog.tsx` | Client: shadcn AlertDialog wrapper |
| `tests/e2e/dashboard-crud.spec.ts` | Playwright happy paths + ACL surfacing |
| `components/ui/dialog.tsx`, `input.tsx`, `label.tsx`, `textarea.tsx`, `sonner.tsx` | shadcn/ui primitives (added via CLI) |

### Modified files

| Path | Change |
|---|---|
| `package.json` | add `react-hook-form`, `@hookform/resolvers` |
| `lib/services/forges.ts` | add `createForge`, `updateForge`, `deleteForge` |
| `lib/services/forges.test.ts` | add tests for the three new mutators (4 ACL classes each) |
| `app/(app)/layout.tsx` | mount `<Toaster />` from sonner |
| `app/(app)/dashboard/page.tsx` | also load `listGroups`; render `DashboardClient` instead of inline list |
| `app/(app)/dashboard/ForgeCard.tsx` | accept `onEdit` / `onDelete` callbacks; render settings + delete buttons |
| `app/(app)/dashboard/ForgeCard.test.tsx` | extend tests for new buttons |

### Tests
- Service: `lib/services/forges.test.ts` (extended), `lib/services/groups.test.ts` (new)
- Pure: `lib/http.test.ts`
- Component: `ForgeCard.test.tsx`, `ForgeFormModal.test.tsx`
- E2E: `tests/e2e/dashboard-crud.spec.ts`

---

## Section A — Foundations

### Task 1: Install runtime dependencies

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Install `react-hook-form` and the Zod resolver**

```bash
pnpm add react-hook-form@^7 @hookform/resolvers@^3
```

Expected: `package.json` `dependencies` gains both packages; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Verify install**

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add react-hook-form and zod resolver"
```

---

### Task 2: Add shadcn/ui primitives (dialog, input, label, textarea, sonner)

**Files:**
- Create: `components/ui/dialog.tsx`, `components/ui/input.tsx`, `components/ui/label.tsx`, `components/ui/textarea.tsx`, `components/ui/sonner.tsx`
- Possibly modify: `package.json` (sonner)

- [ ] **Step 1: Add the primitives via the shadcn CLI**

```bash
pnpm dlx shadcn@latest add dialog input label textarea sonner
```

Expected: five new files appear under `components/ui/`. The CLI may add `sonner` to `package.json` and update the lockfile. Accept any prompts to overwrite.

- [ ] **Step 2: Verify it builds**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0. If lint complains about quotes/semicolons in the generated files, run `pnpm lint --fix` then re-verify.

- [ ] **Step 3: Commit**

```bash
git add components/ui package.json pnpm-lock.yaml
git commit -m "chore(ui): add shadcn dialog/input/label/textarea/sonner primitives"
```

---

### Task 3: Mount the Sonner Toaster in the auth-protected layout

**Files:**
- Modify: `app/(app)/layout.tsx`

- [ ] **Step 1: Edit `app/(app)/layout.tsx`**

Replace the existing file contents with:

```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Topbar } from '@/components/topbar/Topbar';
import { Toaster } from '@/components/ui/sonner';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }
  return (
    <div className="min-h-screen">
      <Topbar user={session.user} />
      {children}
      <Toaster richColors closeButton />
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add 'app/(app)/layout.tsx'
git commit -m "feat(ui): mount Sonner Toaster in auth-protected layout"
```

---

### Task 4: Forge mutation Zod schemas

**Files:**
- Create: `lib/services/forges-schema.ts`

- [ ] **Step 1: Write the schemas**

```ts
import { z } from 'zod';

export const createForgeInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters'),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

export type CreateForgeInput = z.infer<typeof createForgeInput>;

export const updateForgeInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters').optional(),
  description: z.string().trim().max(500, 'Max 500 characters').nullable().optional(),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group').optional(),
});

export type UpdateForgeInput = z.infer<typeof updateForgeInput>;
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/services/forges-schema.ts
git commit -m "feat(services): forge create/update Zod schemas"
```

---

## Section B — Service layer (TDD)

### Task 5: `listGroups` service

**Files:**
- Create: `lib/services/groups.ts`, `lib/services/groups.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/groups.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb } from '@/lib/test/db';
import { listGroups } from './groups';

describe('listGroups', () => {
  it('returns every group, alphabetically by name', async () => {
    await withCleanDb(async (prisma) => {
      await prisma.group.createMany({
        data: [{ name: 'Sales' }, { name: 'Engineering' }, { name: 'Marketing' }],
      });
      const groups = await listGroups();
      expect(groups.map((g) => g.name)).toEqual(['Engineering', 'Marketing', 'Sales']);
      expect(groups[0]).toMatchObject({ id: expect.any(String), name: 'Engineering' });
    });
  });

  it('returns an empty array when no groups exist', async () => {
    await withCleanDb(async () => {
      expect(await listGroups()).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
pnpm test -- groups
```

Expected: FAIL with "Cannot find module './groups'".

- [ ] **Step 3: Implement `listGroups`**

```ts
// lib/services/groups.ts
import { prisma } from '@/lib/prisma';

export type GroupDto = { id: string; name: string };

export async function listGroups(): Promise<GroupDto[]> {
  const rows = await prisma.group.findMany({ orderBy: { name: 'asc' } });
  return rows.map((g) => ({ id: g.id, name: g.name }));
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
pnpm test -- groups
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/services/groups.ts lib/services/groups.test.ts
git commit -m "feat(services): listGroups returns all groups alphabetically"
```

---

### Task 6: `createForge` service (TDD)

**Files:**
- Modify: `lib/services/forges.ts`, `lib/services/forges.test.ts`

`canWriteForge` is the spec's gate for mutation, but **create** has no existing forge to gate on — any authenticated user may create. Rationale: ACL on read still applies, so a user creating a forge in groups they aren't in simply won't see it back in `listForges`. The form will require ≥1 group on the client.

- [ ] **Step 1: Write the failing tests**

Append to `lib/services/forges.test.ts`:

```ts
import { createForge } from './forges';
import { ValidationError } from '@/lib/errors';

describe('createForge', () => {
  it('creates a Forge with derived initials, default status=draft and tone=navy', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: ['Engineering'] });
      await prisma.group.create({ data: { name: 'Engineering' } }).catch(() => {}); // makeUser already created it

      const forge = await createForge(tom, {
        name: 'Aquaflow Designer',
        description: 'Hydraulics tool',
        groups: ['Engineering'],
      });

      expect(forge.name).toBe('Aquaflow Designer');
      expect(forge.initials).toBe('AD');
      expect(forge.status).toBe('draft');
      expect(forge.tone).toBe('navy');
      expect(forge.groups).toEqual(['Engineering']);
      expect(forge.createdBy.id).toBe(tom.id);
    });
  });

  it('persists the join rows so the forge appears in listForges for group members', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      await createForge(tom, { name: 'A', description: '', groups: ['Engineering'] });
      const list = await listForges(maya);
      expect(list.map((f) => f.name)).toEqual(['A']);
    });
  });

  it('throws ValidationError if any group name is unknown', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await expect(
        createForge(tom, { name: 'X', description: '', groups: ['NoSuchGroup'] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
pnpm test -- forges
```

Expected: FAIL with "createForge is not a function" (or similar).

- [ ] **Step 3: Implement `createForge`**

Append to `lib/services/forges.ts` (add a top-level helper for initials and the new function):

```ts
import { ValidationError } from '@/lib/errors';
import type { CreateForgeInput, UpdateForgeInput } from './forges-schema';

function deriveInitials(name: string): string {
  const cleaned = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return cleaned || 'F';
}

export async function createForge(
  currentUser: SessionUser,
  input: CreateForgeInput,
): Promise<Forge> {
  return prisma.$transaction(async (tx) => {
    const groupRows = await tx.group.findMany({ where: { name: { in: input.groups } } });
    if (groupRows.length !== input.groups.length) {
      const known = new Set(groupRows.map((g) => g.name));
      const unknown = input.groups.filter((g) => !known.has(g));
      throw new ValidationError('Unknown group(s)', { groups: unknown });
    }
    const description = input.description?.trim() ? input.description.trim() : null;
    const created = await tx.forge.create({
      data: {
        name: input.name,
        description,
        initials: deriveInitials(input.name),
        createdById: currentUser.id,
        groups: { create: groupRows.map((g) => ({ groupId: g.id })) },
      },
      include: forgeInclude,
    });
    return toDto(created);
  });
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- forges
```

Expected: all forges tests pass (3 new + 6 existing = 9).

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(services): createForge with derived initials and group attach"
```

---

### Task 7: `updateForge` service (TDD on 4 ACL classes)

**Files:**
- Modify: `lib/services/forges.ts`, `lib/services/forges.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/services/forges.test.ts`:

```ts
import { updateForge } from './forges';
import { ForbiddenError } from '@/lib/errors';

describe('updateForge', () => {
  it('creator can update name, description and groups', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      await prisma.group.create({ data: { name: 'Operations' } });
      const forge = await makeForge(prisma, { name: 'Old', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(tom, forge.id, {
        name: 'New',
        description: 'desc',
        groups: ['Operations'],
      });
      expect(updated.name).toBe('New');
      expect(updated.description).toBe('desc');
      expect(updated.groups).toEqual(['Operations']);
    });
  });

  it('admin can update any forge', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(admin, forge.id, { name: 'A2' });
      expect(updated.name).toBe('A2');
    });
  });

  it('group member who is not creator/admin cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(maya, forge.id, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(stranger, forge.id, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        updateForge(u, '00000000-0000-0000-0000-000000000000', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('throws ValidationError when an unknown group is supplied', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(
        updateForge(tom, forge.id, { groups: ['Engineering', 'Imaginary'] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
pnpm test -- forges
```

Expected: FAIL with "updateForge is not a function".

- [ ] **Step 3: Implement `updateForge`**

Append to `lib/services/forges.ts`:

```ts
import { canWriteForge } from '@/lib/acl';

export async function updateForge(
  currentUser: SessionUser,
  id: string,
  input: UpdateForgeInput,
): Promise<Forge> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.forge.findUnique({ where: { id }, include: forgeInclude });
    if (!existing) throw new NotFoundError('forge', id);

    const aclShape = {
      id: existing.id,
      createdById: existing.createdById,
      groups: existing.groups.map((fg) => fg.group.name),
    };
    if (!canWriteForge(currentUser, aclShape)) {
      throw new ForbiddenError(`Cannot update forge ${id}`);
    }

    const data: Prisma.ForgeUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
      data.initials = deriveInitials(input.name);
    }
    if (input.description !== undefined) {
      const trimmed = input.description?.trim() ?? null;
      data.description = trimmed && trimmed.length > 0 ? trimmed : null;
    }

    if (input.groups !== undefined) {
      const groupRows = await tx.group.findMany({ where: { name: { in: input.groups } } });
      if (groupRows.length !== input.groups.length) {
        const known = new Set(groupRows.map((g) => g.name));
        const unknown = input.groups.filter((g) => !known.has(g));
        throw new ValidationError('Unknown group(s)', { groups: unknown });
      }
      await tx.forgeGroup.deleteMany({ where: { forgeId: id } });
      await tx.forgeGroup.createMany({
        data: groupRows.map((g) => ({ forgeId: id, groupId: g.id })),
      });
    }

    const updated = await tx.forge.update({
      where: { id },
      data,
      include: forgeInclude,
    });
    return toDto(updated);
  });
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- forges
```

Expected: all 15 forge tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(services): updateForge with ACL (creator OR admin) and group replace"
```

---

### Task 8: `deleteForge` service (TDD on 4 ACL classes)

**Files:**
- Modify: `lib/services/forges.ts`, `lib/services/forges.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/services/forges.test.ts`:

```ts
import { deleteForge } from './forges';

describe('deleteForge', () => {
  it('creator can delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await deleteForge(tom, forge.id);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
    });
  });

  it('admin can delete a forge they did not create', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await deleteForge(admin, forge.id);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
    });
  });

  it('group member who is not creator/admin cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(maya, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(stranger, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('cascades forge_groups rows when a forge is deleted', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering', 'Operations'] });
      await deleteForge(tom, forge.id);
      const fgRows = await prisma.forgeGroup.findMany({ where: { forgeId: forge.id } });
      expect(fgRows).toEqual([]);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        deleteForge(u, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
pnpm test -- forges
```

Expected: FAIL with "deleteForge is not a function".

- [ ] **Step 3: Implement `deleteForge`**

Append to `lib/services/forges.ts`:

```ts
export async function deleteForge(
  currentUser: SessionUser,
  id: string,
): Promise<void> {
  const existing = await prisma.forge.findUnique({
    where: { id },
    include: forgeInclude,
  });
  if (!existing) throw new NotFoundError('forge', id);

  const aclShape = {
    id: existing.id,
    createdById: existing.createdById,
    groups: existing.groups.map((fg) => fg.group.name),
  };
  if (!canWriteForge(currentUser, aclShape)) {
    throw new ForbiddenError(`Cannot delete forge ${id}`);
  }

  await prisma.forge.delete({ where: { id } }); // ON DELETE CASCADE wipes forge_groups
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- forges
```

Expected: all 21 forge tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/forges.ts lib/services/forges.test.ts
git commit -m "feat(services): deleteForge with ACL and join-table cascade"
```

---

## Section C — REST API

### Task 9: HTTP error-mapping helper (`lib/http.ts`) — TDD

**Files:**
- Create: `lib/http.ts`, `lib/http.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/http.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { respondToServiceError } from './http';
import { NotFoundError, ForbiddenError, ValidationError } from './errors';

describe('respondToServiceError', () => {
  it('maps NotFoundError → 404', async () => {
    const res = respondToServiceError(new NotFoundError('forge', 'abc'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'forge abc not found' });
  });

  it('maps ForbiddenError → 403', async () => {
    const res = respondToServiceError(new ForbiddenError('nope'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'nope' });
  });

  it('maps ValidationError → 400 and includes issues', async () => {
    const res = respondToServiceError(new ValidationError('bad', { name: ['required'] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad', issues: { name: ['required'] } });
  });

  it('maps unknown errors → 500 with a generic body', async () => {
    const res = respondToServiceError(new Error('boom'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Internal Server Error' });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
pnpm test -- http
```

Expected: FAIL with "Cannot find module './http'".

- [ ] **Step 3: Implement the helper**

```ts
// lib/http.ts
import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError, ValidationError } from './errors';

export function respondToServiceError(err: unknown): NextResponse {
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
  }
  console.error('[respondToServiceError] unhandled error', err);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- http
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/http.ts lib/http.test.ts
git commit -m "feat(http): respondToServiceError maps AppError → HTTP"
```

---

### Task 10: `POST /api/forges` route

**Files:**
- Create: `app/api/forges/route.ts`

The middleware (`proxy.ts`) already gates `/api/forges/:path*` with a 401 for unauthenticated requests, so the route can rely on `auth()` returning a session.

- [ ] **Step 1: Implement the route**

```ts
// app/api/forges/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createForge } from '@/lib/services/forges';
import { createForgeInput } from '@/lib/services/forges-schema';
import { respondToServiceError } from '@/lib/http';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const forge = await createForge(session.user, parsed.data);
    return NextResponse.json({ forge }, { status: 201 });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 2: Verify type/lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0. Lint must NOT flag this file (no `@/lib/prisma` import).

- [ ] **Step 3: Commit**

```bash
git add app/api/forges/route.ts
git commit -m "feat(api): POST /api/forges with Zod validation and error mapping"
```

---

### Task 11: `PATCH` and `DELETE /api/forges/:id` route

**Files:**
- Create: `app/api/forges/[id]/route.ts`

Next.js 16 dynamic-route handlers receive `params` as a `Promise` (use the global `RouteContext<...>` helper).

- [ ] **Step 1: Implement the route**

```ts
// app/api/forges/[id]/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { updateForge, deleteForge } from '@/lib/services/forges';
import { updateForgeInput } from '@/lib/services/forges-schema';
import { respondToServiceError } from '@/lib/http';

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = updateForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const forge = await updateForge(session.user, id, parsed.data);
    return NextResponse.json({ forge });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deleteForge(session.user, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 2: Verify type/lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add 'app/api/forges/[id]/route.ts'
git commit -m "feat(api): PATCH and DELETE /api/forges/:id with ACL via service"
```

---

## Section D — UI

### Task 12: Extend `ForgeCard` with edit + delete buttons

**Files:**
- Modify: `app/(app)/dashboard/ForgeCard.tsx`, `app/(app)/dashboard/ForgeCard.test.tsx`

The card currently has no actions. Phase 2 adds two icon buttons in the bottom-right that the parent (`DashboardClient`) wires to its modal handlers.

- [ ] **Step 1: Extend the test first**

Replace `app/(app)/dashboard/ForgeCard.test.tsx` with:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCard } from './ForgeCard';
import type { Forge } from '@/lib/services/types';

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  description: 'Hydraulic modeling toolkit.',
  status: 'active',
  tone: 'navy',
  initials: 'AD',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
};

describe('ForgeCard', () => {
  it('renders name, description, initials, and groups', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('Hydraulic modeling toolkit.')).toBeInTheDocument();
    expect(screen.getByText('AD')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
  });

  it('shows the status label in uppercase form', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.getByText(/ACTIVE/i)).toBeInTheDocument();
  });

  it('does not render edit / delete buttons when callbacks are absent', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onEdit when the edit button is clicked', async () => {
    const onEdit = vi.fn();
    render(<ForgeCard forge={forge} onEdit={onEdit} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(forge);
  });

  it('calls onDelete when the delete button is clicked', async () => {
    const onDelete = vi.fn();
    render(<ForgeCard forge={forge} onEdit={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(forge);
  });
});
```

- [ ] **Step 2: Run the tests — verify the new ones fail**

```bash
pnpm test -- ForgeCard
```

Expected: 2 of 5 fail (button-related).

- [ ] **Step 3: Update `ForgeCard.tsx`**

Replace the file with:

```tsx
'use client';

import { Pencil, Trash2 } from 'lucide-react';
import type { Forge } from '@/lib/services/types';

const TONE_CLASSES: Record<Forge['tone'], string> = {
  navy: 'bg-gradient-to-br from-[rgba(0,46,92,0.9)] to-[rgba(0,28,56,0.9)] text-[#9ec6ee] border-[rgba(60,110,170,0.4)]',
  gold: 'bg-gradient-to-br from-[rgba(185,160,96,0.25)] to-[rgba(140,119,71,0.4)] text-gold-soft border-[rgba(185,160,96,0.45)]',
  grey: 'bg-gradient-to-br from-[rgba(150,150,150,0.25)] to-[rgba(80,80,80,0.4)] text-[#e0e0e0] border-[rgba(150,150,150,0.4)]',
};

const STATUS_DOT: Record<Forge['status'], string> = {
  active: 'bg-[#4ad28b] shadow-[0_0_0_3px_rgba(74,210,139,0.15)]',
  draft: 'bg-[#e0a948] shadow-[0_0_0_3px_rgba(224,169,72,0.15)]',
  archived: 'bg-[#6b7785] shadow-[0_0_0_3px_rgba(107,119,133,0.15)]',
};

const STATUS_LABEL: Record<Forge['status'], string> = {
  active: '● ACTIVE',
  draft: '◐ DRAFT',
  archived: '○ ARCHIVED',
};

type Props = {
  forge: Forge;
  onEdit?: (forge: Forge) => void;
  onDelete?: (forge: Forge) => void;
};

export function ForgeCard({ forge, onEdit, onDelete }: Props) {
  const updated = new Date(forge.updatedAt).toLocaleDateString();
  const showActions = Boolean(onEdit || onDelete);
  return (
    <article className="relative flex min-h-[220px] flex-col gap-4 overflow-hidden rounded-[14px] border border-border bg-panel p-5 transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-panel-2">
      <div className="flex items-start gap-3.5">
        <div className={`grid h-11 w-11 place-items-center rounded-[10px] border text-base font-bold ${TONE_CLASSES[forge.tone]}`}>
          {forge.initials}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold tracking-tight">{forge.name}</h3>
          <div className="font-mono text-[11.5px] tracking-wide text-ink-dim">
            {forge.id.slice(0, 6).toUpperCase()} · updated {updated}
          </div>
        </div>
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[forge.status]}`} title={forge.status} />
      </div>

      <p className="line-clamp-2 text-[13px] leading-snug text-ink-dim">{forge.description ?? 'No description.'}</p>

      <div className="flex flex-wrap gap-1.5">
        {forge.groups.map((g, i) => (
          <span
            key={g}
            className={`rounded-md border border-border bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-ink-dim ${i === 0 ? 'border-gold/30 bg-gold/[0.1] text-gold-soft' : ''}`}
          >
            {g}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3.5">
        <span className="font-mono text-[11px] text-ink-faint">{STATUS_LABEL[forge.status]}</span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint">by {forge.createdBy.name}</span>
          {showActions && (
            <div className="flex items-center gap-1">
              {onEdit && (
                <button
                  type="button"
                  aria-label={`Edit ${forge.name}`}
                  onClick={() => onEdit(forge)}
                  className="rounded-md p-1.5 text-ink-dim transition hover:bg-panel-3 hover:text-ink"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  aria-label={`Delete ${forge.name}`}
                  onClick={() => onDelete(forge)}
                  className="rounded-md p-1.5 text-ink-dim transition hover:bg-[rgba(217,104,104,0.12)] hover:text-[#ff9f9f]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- ForgeCard
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add 'app/(app)/dashboard/ForgeCard.tsx' 'app/(app)/dashboard/ForgeCard.test.tsx'
git commit -m "feat(ui): ForgeCard edit and delete action buttons"
```

---

### Task 13: `DeleteConfirmDialog` component

**Files:**
- Create: `app/(app)/dashboard/DeleteConfirmDialog.tsx`

A controlled wrapper around the shadcn `Dialog` primitive — open/close + onConfirm passed by the parent.

- [ ] **Step 1: Implement the component**

```tsx
// app/(app)/dashboard/DeleteConfirmDialog.tsx
'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Props = {
  open: boolean;
  forgeName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmDialog({ open, forgeName, busy, onCancel, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{forgeName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This permanently deletes the Forge and any conversations attached to it. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add 'app/(app)/dashboard/DeleteConfirmDialog.tsx'
git commit -m "feat(ui): DeleteConfirmDialog wrapper around shadcn Dialog"
```

---

### Task 14: `ForgeFormModal` (create + edit) — TDD

**Files:**
- Create: `app/(app)/dashboard/ForgeFormModal.tsx`, `app/(app)/dashboard/ForgeFormModal.test.tsx`

Single component that handles both create and edit. When a `forge` prop is supplied, populates fields and submits via `PATCH`; otherwise it `POST`s. The parent owns `open` and the `onSaved` callback.

- [ ] **Step 1: Write the failing tests**

```tsx
// app/(app)/dashboard/ForgeFormModal.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeFormModal } from './ForgeFormModal';
import type { Forge } from '@/lib/services/types';

const ALL_GROUPS = [
  { id: 'g1', name: 'Engineering' },
  { id: 'g2', name: 'Operations' },
  { id: 'g3', name: 'Sales' },
];

const FORGE: Forge = {
  id: 'forge-1',
  name: 'Aquaflow',
  description: 'Hydraulics',
  status: 'draft',
  tone: 'navy',
  initials: 'AQ',
  groups: ['Engineering'],
  createdBy: { id: 'u1', name: 'Tom' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('ForgeFormModal', () => {
  it('shows "New Forge" title and empty fields in create mode', () => {
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /new forge/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('');
  });

  it('shows "Edit Forge" title and pre-fills fields in edit mode', () => {
    render(
      <ForgeFormModal
        open
        mode="edit"
        forge={FORGE}
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /edit forge/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('Aquaflow');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Hydraulics');
  });

  it('blocks submit and surfaces a name error when name is empty', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('blocks submit and surfaces a groups error when nothing is picked', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/name/i), 'Test');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/pick at least one group/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('POSTs and calls onSaved when create succeeds', async () => {
    const onSaved = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ forge: { ...FORGE, id: 'new', name: 'Aquaflow', groups: ['Engineering'] } }),
    } as Response);

    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/name/i), 'Aquaflow');
    await userEvent.click(screen.getByRole('button', { name: /^engineering$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/forges',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onSaved).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
pnpm test -- ForgeFormModal
```

Expected: FAIL with "Cannot find module './ForgeFormModal'".

- [ ] **Step 3: Implement the component**

```tsx
// app/(app)/dashboard/ForgeFormModal.tsx
'use client';

import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Forge } from '@/lib/services/types';
import type { GroupDto } from '@/lib/services/groups';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Max 120 characters'),
  description: z.string().trim().max(500, 'Max 500 characters').optional().or(z.literal('')),
  groups: z.array(z.string().min(1)).min(1, 'Pick at least one group'),
});

type FormValues = z.infer<typeof formSchema>;

type Props =
  | {
      open: boolean;
      mode: 'create';
      allGroups: GroupDto[];
      onCancel: () => void;
      onSaved: () => void;
      forge?: never;
    }
  | {
      open: boolean;
      mode: 'edit';
      allGroups: GroupDto[];
      forge: Forge;
      onCancel: () => void;
      onSaved: () => void;
    };

export function ForgeFormModal(props: Props) {
  const { open, mode, allGroups, onCancel, onSaved } = props;
  const initial: FormValues =
    mode === 'edit'
      ? { name: props.forge.name, description: props.forge.description ?? '', groups: props.forge.groups }
      : { name: '', description: '', groups: [] };

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initial,
  });

  useEffect(() => {
    if (open) reset(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values: FormValues) {
    const url = mode === 'edit' ? `/api/forges/${props.forge.id}` : '/api/forges';
    const method = mode === 'edit' ? 'PATCH' : 'POST';
    const body = JSON.stringify({
      name: values.name,
      description: values.description || null,
      groups: values.groups,
    });
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body });
    } catch {
      toast.error('Network error — please try again.');
      return;
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const msg = payload?.error ?? `Request failed (${res.status})`;
      toast.error(msg);
      return;
    }
    toast.success(mode === 'edit' ? 'Forge updated.' : 'Forge created.');
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit Forge' : 'New Forge'}</DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-name">Name</Label>
            <Input id="forge-name" autoFocus {...register('name')} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-xs text-[#ff9f9f]">{errors.name.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forge-description">Description</Label>
            <Textarea id="forge-description" rows={3} {...register('description')} aria-invalid={!!errors.description} />
            {errors.description && <p className="text-xs text-[#ff9f9f]">{errors.description.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Groups</Label>
            <Controller
              control={control}
              name="groups"
              render={({ field }) => {
                const selected = new Set(field.value);
                function toggle(name: string) {
                  const next = new Set(selected);
                  if (next.has(name)) next.delete(name); else next.add(name);
                  field.onChange(Array.from(next));
                }
                return (
                  <div className="flex flex-wrap gap-1.5">
                    {allGroups.map((g) => {
                      const isOn = selected.has(g.name);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => toggle(g.name)}
                          aria-pressed={isOn}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[11px] font-medium transition',
                            isOn
                              ? 'border-gold/40 bg-gold/[0.15] text-gold-soft'
                              : 'border-border bg-white/[0.04] text-ink-dim hover:border-border-strong',
                          )}
                        >
                          {g.name}
                        </button>
                      );
                    })}
                  </div>
                );
              }}
            />
            {errors.groups && <p className="text-xs text-[#ff9f9f]">{errors.groups.message}</p>}
          </div>

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
pnpm test -- ForgeFormModal
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add 'app/(app)/dashboard/ForgeFormModal.tsx' 'app/(app)/dashboard/ForgeFormModal.test.tsx'
git commit -m "feat(ui): ForgeFormModal — create/edit with RHF + Zod and group chips"
```

---

### Task 15: `DashboardClient` — search, filter, modals, optimistic delete

**Files:**
- Create: `app/(app)/dashboard/DashboardClient.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// app/(app)/dashboard/DashboardClient.tsx
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ForgeCard } from './ForgeCard';
import { ForgeFormModal } from './ForgeFormModal';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { cn } from '@/lib/utils';
import type { Forge } from '@/lib/services/types';
import type { GroupDto } from '@/lib/services/groups';

const FILTERS = ['all', 'active', 'draft', 'archived'] as const;
type Filter = (typeof FILTERS)[number];

type Props = {
  initialForges: Forge[];
  allGroups: GroupDto[];
};

export function DashboardClient({ initialForges, allGroups }: Props) {
  const router = useRouter();
  const [forges, setForges] = useState<Forge[]>(initialForges);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Forge | null>(null);
  const [deleting, setDeleting] = useState<Forge | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const counts = useMemo(() => {
    const acc = { all: 0, active: 0, draft: 0, archived: 0 };
    for (const f of forges) {
      acc.all++;
      acc[f.status]++;
    }
    return acc;
  }, [forges]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return forges.filter((f) => {
      if (filter !== 'all' && f.status !== filter) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q) ||
        f.groups.some((g) => g.toLowerCase().includes(q))
      );
    });
  }, [forges, filter, query]);

  async function handleConfirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleteBusy(true);
    setForges((current) => current.filter((f) => f.id !== target.id));
    try {
      const res = await fetch(`/api/forges/${target.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error ?? `Delete failed (${res.status})`);
      }
      toast.success(`Deleted “${target.name}”.`);
      setDeleting(null);
      router.refresh();
    } catch (err) {
      setForges((current) => [target, ...current]);
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-8 py-10 pb-20">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Forges</h1>
          <div className="mt-1.5 text-sm text-ink-dim">
            <b className="font-medium text-ink">{counts.all}</b> applications ·{' '}
            <b className="font-medium text-ink">{counts.active}</b> active ·{' '}
            <b className="font-medium text-ink">{counts.draft}</b> in draft
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Forge
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, description, or group…"
            aria-label="Search forges"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Status filter">
          {FILTERS.map((f) => {
            const isOn = filter === f;
            return (
              <button
                key={f}
                role="tab"
                aria-selected={isOn}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] font-medium uppercase tracking-wide transition',
                  isOn
                    ? 'border-gold/40 bg-gold/[0.15] text-gold-soft'
                    : 'border-border bg-white/[0.04] text-ink-dim hover:border-border-strong',
                )}
              >
                {f === 'all' ? `All (${counts.all})` : `${f} (${counts[f]})`}
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border bg-white/[0.015] py-16 text-center text-ink-dim">
          <h4 className="mb-1.5 text-base font-medium text-ink">No forges match your filters.</h4>
          <p>Try clearing the search or switching status.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-[1.125rem]">
          {visible.map((f) => (
            <ForgeCard
              key={f.id}
              forge={f}
              onEdit={(forge) => setEditing(forge)}
              onDelete={(forge) => setDeleting(forge)}
            />
          ))}
        </div>
      )}

      <ForgeFormModal
        open={createOpen}
        mode="create"
        allGroups={allGroups}
        onCancel={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />

      {editing && (
        <ForgeFormModal
          open
          mode="edit"
          forge={editing}
          allGroups={allGroups}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <DeleteConfirmDialog
        open={!!deleting}
        forgeName={deleting?.name ?? ''}
        busy={deleteBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
      />
    </main>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck && pnpm lint
```

Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add 'app/(app)/dashboard/DashboardClient.tsx'
git commit -m "feat(ui): DashboardClient with search, filter chips and optimistic delete"
```

---

### Task 16: Wire `DashboardClient` into the page (load groups + forges)

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Replace the page**

```tsx
// app/(app)/dashboard/page.tsx
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listForges } from '@/lib/services/forges';
import { listGroups } from '@/lib/services/groups';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [forges, allGroups] = await Promise.all([
    listForges(session.user),
    listGroups(),
  ]);

  return <DashboardClient initialForges={forges} allGroups={allGroups} />;
}
```

- [ ] **Step 2: Verify (typecheck + lint + unit tests)**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add 'app/(app)/dashboard/page.tsx'
git commit -m "feat(ui): dashboard page wires DashboardClient with forges + groups"
```

---

## Section E — End-to-end tests

### Task 17: Playwright happy paths + ACL toast

**Files:**
- Create: `tests/e2e/dashboard-crud.spec.ts`

The Playwright config already re-seeds the DB before the run via `tests/e2e/global-setup.ts`. Each test starts with a clean cookie jar.

- [ ] **Step 1: Write the spec**

Each test is independent — none reads state another test wrote. Forges created mid-test are deleted via API at the end so the run doesn't leave orphans. The ACL assertion is direct-API (cleaner than scraping ids out of the DOM); the service-layer tests in Tasks 7–8 cover the full ACL matrix.

```ts
import { test, expect, type Page } from '@playwright/test';

const SEED_USERS = {
  maya:  'maya.chen@crystalfountains.com',
  tom:   'tom.reed@crystalfountains.com',
  admin: 'admin@crystalfountains.com',
};

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('Maya creates a new Forge in Engineering and sees it on the dashboard', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /new forge/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /new forge/i })).toBeVisible();
  await dialog.getByLabel(/^name$/i).fill('E2E Create');
  await dialog.getByLabel(/description/i).fill('Created from e2e.');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();

  await expect(page.getByText(/forge created/i)).toBeVisible();
  await expect(page.getByText('E2E Create')).toBeVisible();

  // cleanup: find the just-created forge via a fresh GET-equivalent (api list isn't shipped in Phase 2,
  // so use the modal's response by capturing the API call). Simpler: trigger delete through the UI.
  await page.locator('article', { hasText: 'E2E Create' }).getByRole('button', { name: /^delete/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^delete$/i }).click();
});

test('Maya edits Forge Labs (her own) and sees the new name', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  const card = page.locator('article', { hasText: 'Forge Labs' });
  await card.getByRole('button', { name: /^edit forge labs$/i }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('Forge Labs (E2E)');
  await dialog.getByRole('button', { name: /save changes/i }).click();

  await expect(page.getByText(/forge updated/i)).toBeVisible();
  await expect(page.getByText('Forge Labs (E2E)')).toBeVisible();

  // restore so subsequent runs (without re-seed) still find it
  await page.locator('article', { hasText: 'Forge Labs (E2E)' }).getByRole('button', { name: /^edit/i }).click();
  await page.getByRole('dialog').getByLabel(/^name$/i).fill('Forge Labs');
  await page.getByRole('dialog').getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/forge updated/i)).toBeVisible();
});

test('Maya deletes a Forge and the card disappears', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  // Create a throwaway forge via the UI so the test owns its lifetime.
  await page.getByRole('button', { name: /new forge/i }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('E2E Delete Target');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByText('E2E Delete Target')).toBeVisible();

  // Now delete it.
  await page.locator('article', { hasText: 'E2E Delete Target' })
    .getByRole('button', { name: /^delete e2e delete target$/i }).click();

  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /delete/i })).toBeVisible();
  await dialog.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByText(/deleted/i)).toBeVisible();
  await expect(page.locator('article', { hasText: 'E2E Delete Target' })).toHaveCount(0);
});

test('Direct DELETE on a forge the user cannot write returns 403', async ({ page }) => {
  // Maya creates a forge in Engineering.
  await devLogin(page, SEED_USERS.maya);
  const createRes = await page.request.post('/api/forges', {
    data: { name: 'E2E ACL', description: '', groups: ['Engineering'] },
  });
  expect(createRes.status()).toBe(201);
  const { forge } = await createRes.json();

  // Tom (Operations/Service, not creator, not admin) tries to DELETE.
  await page.context().clearCookies();
  await devLogin(page, SEED_USERS.tom);
  const delRes = await page.request.delete(`/api/forges/${forge.id}`);
  expect(delRes.status()).toBe(403);
  expect((await delRes.json()).error).toMatch(/cannot delete/i);

  // Admin cleans up so the DB stays tidy for re-runs.
  await page.context().clearCookies();
  await devLogin(page, SEED_USERS.admin);
  const cleanup = await page.request.delete(`/api/forges/${forge.id}`);
  expect(cleanup.status()).toBe(204);
});
```

> **Note for the executing engineer:** the four-class ACL matrix (creator / admin / non-creator group member / non-member) is exhaustively covered by the service-layer tests in Tasks 7 and 8. The `direct DELETE → 403` test above proves the boundary survives the route handler's error mapping; the toast surfacing is verified manually in the sign-off step.

- [ ] **Step 2: Run the spec**

Make sure Postgres is healthy first:

```bash
docker compose ps
AUTH_DEV_USERS_ENABLED=true pnpm e2e
```

Expected: all 4 dashboard-spine tests still pass + 4 new dashboard-crud tests pass = 8 of 8.

- [ ] **Step 3: Debug if needed**

- "Cannot find dialog role" → confirm shadcn `Dialog` renders with `role="dialog"` (it does by default via base-ui).
- Toast not visible → ensure `<Toaster />` is mounted in `(app)/layout.tsx` (Task 3).
- Group chip not clicked → button is `<button type="button">` with the group name as accessible text; use `getByRole('button', { name: /^engineering$/i })`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dashboard-crud.spec.ts
git commit -m "test(e2e): dashboard CRUD happy paths and ACL surface"
```

---

### Task 18: Phase 2 sign-off

- [ ] **Step 1: Run the full test suite**

```bash
pnpm typecheck && pnpm lint && pnpm test && AUTH_DEV_USERS_ENABLED=true pnpm e2e
```

Expected: all green.

- [ ] **Step 2: Manual smoke (one user, one CRUD round-trip)**

```bash
docker compose ps && pnpm db:reset && pnpm db:seed && pnpm dev -p 80
```

In a browser at `http://localhost`:

1. Sign in as `maya.chen@crystalfountains.com` via the dev panel.
2. Click **New Forge**, fill name `Smoke Test`, description `from manual smoke`, pick **Engineering**, click **Create** → toast appears, card appears.
3. Click the pencil on `Smoke Test`, change the name to `Smoke Test 2`, click **Save changes** → toast appears, card name updates.
4. Click the trash on `Smoke Test 2`, confirm in the dialog → toast appears, card disappears.
5. Type `aqua` into the search bar → only matching forges visible. Clear it.
6. Click **DRAFT** filter chip → only draft forges visible. Click **ALL**.

Stop the server.

- [ ] **Step 3: Tag**

```bash
git tag phase-2-dashboard-crud -m "Phase 2 dashboard CRUD complete"
```

(No `git push` from this plan — operator's responsibility.)

---

## Self-Review

- ✅ **Spec coverage** — every Phase 2 §7 bullet maps to a task: search/filter chips → Task 15; New Forge → Tasks 14–15; Settings pencil → Tasks 12, 14, 15; Delete + DeleteConfirmDialog → Tasks 13, 15; Sonner toasts → Tasks 3, 14, 15; service `create/update/delete` with ACL → Tasks 6–8; REST mutations → Tasks 10–11; multi-select group chips → Task 14; Zod at API boundary → Tasks 4, 10–11; react-hook-form → Tasks 1, 14; optimistic delete → Task 15; Playwright happy paths → Task 17; service-layer Vitest covering 4 ACL classes → Tasks 7–8.
- ✅ **Placeholder scan** — no "TBD"/"TODO"/"implement later". Every code block is complete.
- ✅ **Type consistency** — `CreateForgeInput`/`UpdateForgeInput` defined in Task 4 are imported by service (Tasks 6–8) and routes (Tasks 10–11); `GroupDto` defined in Task 5 is imported by `ForgeFormModal` (Task 14) and `DashboardClient` (Task 15); `Forge` from `lib/services/types.ts` flows unchanged.
- ✅ **Spec gaps** — the spec lists `GET /api/forges` and `GET /api/forges/:id` in §6's table. Phase 2 features do not require either (dashboard list is SSR; modal opens with in-memory data). They are deferred — not blocking — and are noted in the e2e task. The plan does not regress Phase 1 functionality: the existing `dashboard-spine.spec.ts` continues to pass.
- ✅ **ACL coverage** — service tests in Tasks 7 and 8 each exercise the four classes called out in the DoD: creator, admin, group member (non-creator), non-member.

---

## Execution handoff

Plan complete and saved. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration with two-stage review.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
