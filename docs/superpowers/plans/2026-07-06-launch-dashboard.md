# Launch Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/launch` page showing only the running forges the user can access, as large bold cards that open the forge's live app (`/app/{slug}/`) in a new window.

**Architecture:** Server component fetches the ACL-filtered forge list (`listForges`), a client component reuses the existing `useForgeRuntimes` 3-second poll and renders a `LaunchCard` only for forges whose runtime status is `running`. No new API routes, services, or schema. Spec: `docs/superpowers/specs/2026-07-06-launch-dashboard-design.md`.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, Vitest + Testing Library.

## Global Constraints

- TypeScript strict; `pnpm typecheck` and `pnpm lint` must pass.
- Tests are colocated next to source as `*.test.tsx` and run with `pnpm test` (Vitest + jsdom + Testing Library).
- This repo's Next.js 16 may differ from your training data — the patterns in this plan were checked against `node_modules/next/dist/docs/`; copy them exactly rather than substituting remembered APIs.
- No new dependencies.
- Card click target is `/app/{slug}/` (trailing slash), opened with `target="_blank" rel="noopener noreferrer"`.
- Only `status === 'running'` forges get a card; every other state (absent, starting, stopping, crashed, setup-failed) renders nothing for that forge.

---

### Task 1: Extract shared forge tone classes

`TONE_CLASSES` is currently a local const in `ForgeCard.tsx`; both cards need it. Pure refactor — existing tests are the safety net, no new tests.

**Files:**
- Create: `components/forge-tone.ts`
- Modify: `app/(app)/dashboard/ForgeCard.tsx:13-17` (remove local const, import instead)

**Interfaces:**
- Consumes: `Forge` type from `@/lib/services/types`.
- Produces: `TONE_CLASSES: Record<Forge['tone'], string>` exported from `@/components/forge-tone` — Tasks 2's `LaunchCard` imports it.

- [ ] **Step 1: Create the shared module**

```ts
// components/forge-tone.ts
import type { Forge } from '@/lib/services/types';

/** Gradient/border/text treatment for a forge's tone-colored initials block. */
export const TONE_CLASSES: Record<Forge['tone'], string> = {
  navy: 'bg-gradient-to-br from-[rgba(0,46,92,0.9)] to-[rgba(0,28,56,0.9)] text-[#9ec6ee] border-[rgba(60,110,170,0.4)]',
  gold: 'bg-gradient-to-br from-[rgba(185,160,96,0.25)] to-[rgba(140,119,71,0.4)] text-gold-soft border-[rgba(185,160,96,0.45)]',
  grey: 'bg-gradient-to-br from-[rgba(150,150,150,0.25)] to-[rgba(80,80,80,0.4)] text-[#e0e0e0] border-[rgba(150,150,150,0.4)]',
};
```

- [ ] **Step 2: Point ForgeCard at it**

In `app/(app)/dashboard/ForgeCard.tsx`, delete the local `TONE_CLASSES` const (lines 13–17) and add to the imports:

```ts
import { TONE_CLASSES } from '@/components/forge-tone';
```

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm test ForgeCard && pnpm typecheck`
Expected: all ForgeCard tests PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add components/forge-tone.ts "app/(app)/dashboard/ForgeCard.tsx"
git commit -m "refactor(dashboard): extract forge tone classes to shared module"
```

---

### Task 2: LaunchCard component

Large, bold, presentational card. The whole card is one anchor to the running app. Lower edge holds name + group pills; the area above them is deliberately empty (future hero image).

**Files:**
- Create: `app/(app)/launch/LaunchCard.tsx`
- Test: `app/(app)/launch/LaunchCard.test.tsx`

**Interfaces:**
- Consumes: `Forge` from `@/lib/services/types`; `TONE_CLASSES` from `@/components/forge-tone` (Task 1).
- Produces: `LaunchCard({ forge, slug }: { forge: Forge; slug: string })` — Task 3's `LaunchClient` renders it with the slug taken from the forge's runtime entry.

- [ ] **Step 1: Write the failing test**

```tsx
// app/(app)/launch/LaunchCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LaunchCard } from './LaunchCard';
import type { Forge } from '@/lib/services/types';

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  description: 'Hydraulic modeling toolkit.',
  tone: 'navy',
  initials: 'AD',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
  repoFullName: 'CrystalFountainsInc/aquaflow-designer',
  repoUrl: 'https://github.com/CrystalFountainsInc/aquaflow-designer',
};

describe('LaunchCard', () => {
  it('renders name, initials, and group tags', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('AD')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
  });

  it('is a single link opening the running app in a new window', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    const link = screen.getByRole('link', { name: /open aquaflow designer/i });
    expect(link).toHaveAttribute('href', '/app/aquaflow-designer/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test LaunchCard`
Expected: FAIL — cannot resolve `./LaunchCard`.

- [ ] **Step 3: Write the component**

```tsx
// app/(app)/launch/LaunchCard.tsx
'use client';

import type { Forge } from '@/lib/services/types';
import { TONE_CLASSES } from '@/components/forge-tone';

type Props = {
  forge: Forge;
  /** Runtime slug — the running app is served at /app/{slug}/. */
  slug: string;
};

export function LaunchCard({ forge, slug }: Props) {
  return (
    <a
      href={`/app/${slug}/`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${forge.name}`}
      className="group relative flex min-h-[220px] flex-col justify-end overflow-hidden rounded-[14px] border border-border bg-panel p-6 transition hover:-translate-y-1 hover:border-border-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      {/* Empty upper area — reserved for a future hero image */}
      <div className={`mb-4 grid h-14 w-14 shrink-0 place-items-center rounded-[10px] border text-lg font-bold ${TONE_CLASSES[forge.tone]}`}>
        {forge.initials}
      </div>
      <h3 className="text-2xl font-bold tracking-tight">{forge.name}</h3>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {forge.groups.map((g, i) => (
          <span
            key={g}
            className={`rounded-md border border-border bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-ink-dim ${i === 0 ? 'border-gold/30 bg-gold/[0.1] text-gold-soft' : ''}`}
          >
            {g}
          </span>
        ))}
      </div>
    </a>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test LaunchCard`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/launch/LaunchCard.tsx" "app/(app)/launch/LaunchCard.test.tsx"
git commit -m "feat(launch): LaunchCard opens a running forge app in a new window"
```

---

### Task 3: LaunchClient — running-forge filter + grid + empty state

Client component that polls runtimes via the existing hook and shows a card per running forge.

**Files:**
- Create: `app/(app)/launch/LaunchClient.tsx`
- Test: `app/(app)/launch/LaunchClient.test.tsx`

**Interfaces:**
- Consumes: `useForgeRuntimes()` from `@/app/(app)/dashboard/useForgeRuntimes` (returns `{ runtimes: Record<string, RuntimeStateView>, refetch }`); `LaunchCard({ forge, slug })` from Task 2.
- Produces: `LaunchClient({ forges }: { forges: Forge[] })` — Task 4's server page renders it.

- [ ] **Step 1: Write the failing test**

```tsx
// app/(app)/launch/LaunchClient.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LaunchClient } from './LaunchClient';
import type { Forge } from '@/lib/services/types';
import type { RuntimeMap } from '@/app/(app)/dashboard/useForgeRuntimes';

const mockRuntimes: { current: RuntimeMap } = { current: {} };
vi.mock('@/app/(app)/dashboard/useForgeRuntimes', () => ({
  useForgeRuntimes: () => ({ runtimes: mockRuntimes.current, refetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));

function makeForge(id: string, name: string): Forge {
  return {
    id,
    name,
    description: null,
    tone: 'navy',
    initials: name.slice(0, 2).toUpperCase(),
    groups: ['Engineering'],
    createdBy: { id: 'tom', name: 'Tom Reed' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T12:00:00Z',
    repoFullName: `CrystalFountainsInc/${id}`,
    repoUrl: `https://github.com/CrystalFountainsInc/${id}`,
  };
}

const forges = [makeForge('f1', 'Aquaflow'), makeForge('f2', 'Cascade')];

beforeEach(() => {
  mockRuntimes.current = {};
});

describe('LaunchClient', () => {
  it('shows only forges whose runtime is running', () => {
    mockRuntimes.current = {
      f1: { forgeId: 'f1', slug: 'aquaflow', status: 'running', port: 4101, startedAt: '2026-07-06T00:00:00Z' },
      f2: { forgeId: 'f2', slug: 'cascade', status: 'starting', port: 4102, startedAt: '2026-07-06T00:00:00Z' },
    };
    render(<LaunchClient forges={forges} />);
    expect(screen.getByText('Aquaflow')).toBeInTheDocument();
    expect(screen.queryByText('Cascade')).not.toBeInTheDocument();
  });

  it('links each card to the runtime slug', () => {
    mockRuntimes.current = {
      f1: { forgeId: 'f1', slug: 'aquaflow', status: 'running', port: 4101, startedAt: '2026-07-06T00:00:00Z' },
    };
    render(<LaunchClient forges={forges} />);
    expect(screen.getByRole('link', { name: /open aquaflow/i })).toHaveAttribute('href', '/app/aquaflow/');
  });

  it('shows the empty state with a dashboard link when nothing is running', () => {
    render(<LaunchClient forges={forges} />);
    expect(screen.getByText(/no forges are running right now/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test LaunchClient`
Expected: FAIL — cannot resolve `./LaunchClient`.

- [ ] **Step 3: Write the component**

```tsx
// app/(app)/launch/LaunchClient.tsx
'use client';

import Link from 'next/link';
import type { Forge } from '@/lib/services/types';
import { useForgeRuntimes } from '@/app/(app)/dashboard/useForgeRuntimes';
import { LaunchCard } from './LaunchCard';

type Props = { forges: Forge[] };

export function LaunchClient({ forges }: Props) {
  const { runtimes } = useForgeRuntimes();

  const running = forges.flatMap((forge) => {
    const rt = runtimes[forge.id];
    return rt?.status === 'running' ? [{ forge, slug: rt.slug }] : [];
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-8 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Launch</h1>
      <p className="mt-1 text-[13px] text-ink-dim">
        Running forges you have access to — click a card to open the app in a new window.
      </p>
      {running.length === 0 ? (
        <div className="mt-20 text-center text-ink-dim">
          <p>No forges are running right now.</p>
          <Link href="/dashboard" className="mt-2 inline-block text-gold-soft hover:underline">
            Go to the dashboard to start one
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {running.map(({ forge, slug }) => (
            <LaunchCard key={forge.id} forge={forge} slug={slug} />
          ))}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test LaunchClient`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/launch/LaunchClient.tsx" "app/(app)/launch/LaunchClient.test.tsx"
git commit -m "feat(launch): LaunchClient renders live grid of running forges"
```

---

### Task 4: /launch page and topbar link

Server page mirroring `app/(app)/dashboard/page.tsx`, plus a visible inline "Launch" link in the topbar (the topbar currently has no inline nav; the link goes between the brand block and the user menu).

**Files:**
- Create: `app/(app)/launch/page.tsx`
- Modify: `components/topbar/Topbar.tsx` (add Link import + nav link)
- Test: `components/topbar/Topbar.test.tsx` (add one test + next/link mock)

**Interfaces:**
- Consumes: `auth()` from `@/lib/auth`; `listForges(user)` from `@/lib/services/forges`; `LaunchClient` from Task 3.
- Produces: the `/launch` route; no downstream consumers.

- [ ] **Step 1: Write the failing topbar test**

Add to `components/topbar/Topbar.test.tsx` — a `next/link` mock next to the existing `next-auth/react` mock, and a new test inside `describe('Topbar', ...)`:

```tsx
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));
```

```tsx
  it('renders a Launch nav link', () => {
    render(<Topbar user={user} />);
    const link = screen.getByRole('link', { name: /launch/i });
    expect(link).toHaveAttribute('href', '/launch');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test Topbar`
Expected: FAIL — "Unable to find an accessible element with the role link".

- [ ] **Step 3: Add the topbar link**

In `components/topbar/Topbar.tsx`, add `import Link from 'next/link';` at the top, and replace `<UserMenu user={user} />` with:

```tsx
      <div className="flex items-center gap-6">
        <Link
          href="/launch"
          className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim transition hover:text-ink"
        >
          Launch
        </Link>
        <UserMenu user={user} />
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test Topbar`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the server page**

```tsx
// app/(app)/launch/page.tsx
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listForges } from '@/lib/services/forges';
import { LaunchClient } from './LaunchClient';

export const dynamic = 'force-dynamic';

export default async function LaunchPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const forges = await listForges(session.user);

  return <LaunchClient forges={forges} />;
}
```

(No unit test for the page — mirrors the repo's convention: `dashboard/page.tsx` has none. Coverage comes from the client-component tests plus the manual check below.)

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/PASS.

Manual check (dev): with `GITHUB_CLIENT_MODE=fake` and the dev server running, sign in, start a forge from `/dashboard`, open `/launch` — a card appears once the forge reaches running, clicking it opens `/app/{slug}/` in a new tab, stopping the forge removes the card within ~3s, and with nothing running the empty state links back to `/dashboard`.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/launch/page.tsx" components/topbar/Topbar.tsx components/topbar/Topbar.test.tsx
git commit -m "feat(launch): /launch page listing running forges, topbar link"
```
