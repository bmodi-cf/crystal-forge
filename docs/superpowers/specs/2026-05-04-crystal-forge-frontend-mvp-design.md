# Crystal Forge — Frontend MVP Design

- **Date:** 2026-05-04
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Frontend MVP (one of several slices that together build the full Crystal Forge platform; see *Out of Scope* for everything explicitly deferred)

## 1. Summary

Build a working Next.js 15 application that implements the three prototype screens shipped in `design/project/` (Login, Dashboard, Forge workspace) as a real, on-prem-deployable product. The app authenticates users against Microsoft Entra ID, persists Forge metadata and conversations to a dedicated Postgres database, and enforces per-group access control. The Forge builder's chat experience is real (composer, persistence, conversation history, optimistic UI) but the AI is scripted: every assistant reply is a canned message until a later slice wires up real LLM generation.

This slice does **not** include document ingestion, RAG, ERP mirroring, real LLM/code generation, sandboxed execution, an admin UI, or Docker packaging. Each of those is a separate slice with its own spec → plan → implementation cycle.

## 2. Goals & Non-Goals

### Goals
- Visual fidelity to the three HTML/CSS prototypes; pixel-eye match on first render of each screen.
- Real Microsoft Entra ID single sign-on, with first-login auto-provisioning of the local `users` row.
- Persistent Forges and chat conversations in a dedicated Postgres database.
- Per-group ACLs enforced at the service layer, with a creator-or-admin write rule.
- A complete REST API surface (`/api/forges`, `/api/conversations`, `/api/conversations/:id/messages`) that mirrors what future Forges and AI services will consume — observable in the browser network tab during use.
- Local development workflow that supports impersonating multiple seeded users without round-tripping through Entra.

### Non-Goals (this slice)
- Real LLM generation, real preview generation, document ingestion, ERP mirror, RAG, sandboxed execution.
- Admin UI for managing users, groups, or roles. Memberships and roles are seeded directly via SQL.
- Docker / containerisation. The next slice handles that; this slice runs as `next start` against a host-installed (or compose-up'd dev) Postgres.
- Read-only shared conversations across a group. Schema is forward-compatible; UI is not built.
- Soft delete. Deletes are hard; recovery is from Postgres backups (ops responsibility, out of repo).
- i18n, full WCAG audit, visual regression testing, performance/load testing, multi-tenant.

## 3. Architecture & Runtime Topology

### Runtime shape
```
Browser
  │ HTTPS (via on-prem reverse proxy — owned by ops, not in this repo)
  ▼
Next.js 15 (next start, Node 20, on-prem Crystal Fountains host)
  │
  ├── App Router pages + route handlers (Server Components by default)
  ├── Auth.js — OIDC dance with Entra ID (login.microsoftonline.com)
  └── Prisma Client
       │
       ▼
   Postgres 16 (dedicated to this app, on-prem)
```

A single deployable Next.js application. One Postgres database, used only by this app. Entra ID is the only external dependency, accessed only during the OAuth login flow. There are no microservices, no separate auth service, no Redis, and no shared databases in this slice.

### Repo layout
Single Next.js app, no monorepo:
```
crystal-forge/
├── app/                       # Next.js App Router
│   ├── (auth)/login/page.tsx
│   ├── (app)/dashboard/page.tsx
│   ├── (app)/forge/[id]/page.tsx
│   ├── api/auth/[...nextauth]/route.ts
│   └── layout.tsx
├── components/                # shared + feature components, colocated tests
├── lib/
│   ├── auth.ts                # Auth.js config + getSession helper
│   ├── acl.ts                 # canRead / canWrite predicates + filters
│   ├── prisma.ts              # Prisma singleton
│   ├── env.ts                 # zod-validated env
│   ├── errors.ts              # NotFoundError / ForbiddenError / ValidationError
│   └── services/              # ONLY layer that touches Prisma
│       ├── forges.ts
│       ├── conversations.ts
│       ├── messages.ts
│       └── users.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── tests/e2e/                 # Playwright specs
├── docker-compose.yml         # dev-only Postgres
├── tailwind.config.ts
├── eslint.config.ts           # custom rule: no Prisma outside lib/services
└── next.config.ts
```

### Data flow patterns (Pattern Z: SSR + complete REST API)

- **Initial page paint** — Server Component calls `lib/services/*` directly. No browser network call for the first read.
- **Mutations** (create, update, delete, send message) — Client Component calls `fetch('/api/...')`. Visible in the browser's network tab. On success, `router.refresh()` revalidates Server Component data.
- **REST endpoints exist for every action**, are curl-able, and use the same service functions and ACL enforcement as Server Components. Future Forges, AI services, ops scripts, and external tools all integrate through this REST surface.
- **Strict architectural rule, lint-enforced:** only modules under `lib/services/*` may import `lib/prisma`. Route handlers and Server Components are thin adapters that call services and trust them.

### Local dev environment
- Next.js runs on port 80: `next dev -p 80` for development, `next build && next start -p 80` for production-mode local testing. WSL2 with admin allows binding port 80.
- `NEXTAUTH_URL=http://localhost`. Entra app registration's redirect URI: `http://localhost/api/auth/callback/microsoft-entra-id`.
- A `docker-compose.yml` provides a local Postgres for dev and tests only. Production deployment uses a separately provisioned on-prem Postgres (the next slice owns that decision).

## 4. Data Model

Prisma schema (illustrative; see actual `schema.prisma` for canonical form):

```
users
  id            uuid pk
  entra_oid     text unique           # Entra subject (sub) — stable identifier
  email         text unique
  name          text
  initials      text                  # for avatar; default: derived from name
  created_at    timestamptz
  updated_at    timestamptz

groups
  id            uuid pk
  name          text unique           # "Engineering", "R&D", "Sales", ... — seeded
  created_at    timestamptz

user_groups                           # M:N membership, seeded directly in DB
  user_id       fk users
  group_id      fk groups
  pk (user_id, group_id)

user_roles                            # admin escape hatch, seeded in DB
  user_id       fk users
  role          enum('admin')         # only one role in this MVP
  pk (user_id, role)

forges
  id            uuid pk
  name          text
  description   text nullable
  status        enum('active','draft','archived') default 'draft'
  tone          enum('navy','gold','grey')        # card icon styling, persisted
  initials      text                              # 2-char card badge, persisted
  created_by    fk users  not null
  created_at    timestamptz
  updated_at    timestamptz

forge_groups                          # M:N — the ACL surface
  forge_id      fk forges  on delete cascade
  group_id      fk groups
  pk (forge_id, group_id)

conversations                         # per-Forge, scoped per-user
  id            uuid pk
  forge_id      fk forges  on delete cascade
  created_by    fk users   restrict
  title         text  default 'New conversation'
  created_at    timestamptz
  updated_at    timestamptz

messages
  id              uuid pk
  conversation_id fk conversations  on delete cascade
  role            enum('user','assistant')
  content         text
  created_at      timestamptz
```

Plus Auth.js's `Account`, `Session`, and `VerificationToken` tables (managed by `@auth/prisma-adapter`; we do not hand-write them).

### Indexes
- `forges(created_by)` — for "my forges" queries
- `forges(status)` — for filter chips
- `forge_groups(group_id, forge_id)` — for the ACL read query
- `conversations(forge_id, created_by)` — for "my conversations in this forge"
- `messages(conversation_id, created_at)` — for chronological ordering

### Notable schema choices (with rationale)
- **`tone` and `initials` are persisted, not derived.** Stable visual identity across renders; potentially user-editable in future without schema change.
- **`forges.created_by` is NOT NULL.** The creator-or-admin write rule depends on this being reliable.
- **`conversations.created_by` is RESTRICT, not CASCADE.** Deleting a user must not orphan-or-cascade their conversations silently. We do not currently delete users (Entra disablement is sufficient), so this never fires in practice.
- **No `metadata` JSONB on `messages`.** Scripted replies are plain text. When real LLM lands and needs tool calls / build steps / token counts, that is a future migration — cheap to add then, no point speculating now.
- **No `is_shared` on `conversations`.** The user-scoping rule lives in the read query (`WHERE created_by = currentUser.id`). Adding `is_shared` later is one nullable column and a tweak to that predicate; no schema break.
- **No soft delete.** Deferred. Schema is purely additive when it is later introduced.

### Seed data (`prisma/seed.ts`)
- 9 prototype Forges from `Dashboard.html` seed array (Aquaflow Designer, Site Survey Pro, QuoteBuilder, Maintenance Hub, BrandKit Manager, PeoplePulse, Forge Labs, InvoiceBridge, Showcase Gallery), with realistic group tags.
- 8 groups: Engineering, Operations, Sales, Finance, Marketing, HR, Service, R&D.
- 3–4 dev users including Maya Chen (multi-group member), Tom Reed (creator of several Forges), Alice Green (single-group), and one user with `user_roles.role='admin'`.
- Wired so dev impersonation gives meaningful ACL coverage out of the box (Maya sees a subset; admin sees all).

## 5. Authentication & Authorisation

### Auth.js configuration
- Provider: `@auth/core/providers/microsoft-entra-id`, configured with Crystal Fountains' Entra tenant ID, client ID, and secret from env.
- Adapter: `@auth/prisma-adapter`. Auth.js manages `Account`, `Session`, `VerificationToken` tables.
- **Session strategy: database sessions** (cookie carries opaque token; session rebuilt server-side per `auth()` call). Allows dynamic group/admin enrichment per request and instant invalidation.
- `pages.signIn = '/login'` — our custom login page.
- `signIn` callback upserts the local `users` row from Entra claims:
  - `entra_oid = account.providerAccountId`
  - `email`, `name` from profile
  - `initials = computeInitials(name)`
  First login auto-provisions the user. Group memberships are **never** auto-joined; they require a deliberate DB insert (this is by design — no admin UI, all memberships audit-able via migration history).

### Session shape
```ts
{
  user: {
    id: string          // local users.id (use this for FKs, never entra_oid)
    entraOid: string
    email: string
    name: string
    initials: string
    groups: string[]    // group names, joined fresh each request
    isAdmin: boolean    // user_roles.role='admin' present
  }
}
```
The `session` callback runs one query per `auth()` call to join `user_groups` and `user_roles`. One DB roundtrip per page is acceptable at this scale; if it becomes a hot path, cache or move to JWT — not a problem to solve now.

### JWT — future option, not planned
Switching from database sessions to JWT later is a configuration change (~30 min plus comms; existing sessions are invalidated). Likely never needed at this scale. Documented as a possibility, not a planned migration.

### Dev-only impersonation
Behind `AUTH_DEV_USERS_ENABLED=true`:
- A second Auth.js Credentials provider exposed on the login page as a "Dev sign-in" panel: dropdown of seeded users → click → signed in as that user, no OIDC dance.
- A `POST /api/dev/switch-user` endpoint accepting `{ email }` and creating a session, for use by Playwright specs and ad-hoc testing.

**Two-layer gate** for the dev-only surface:
1. The credentials provider is only registered when the env flag is set, so the OAuth-equivalent flow is unavailable in production.
2. The `/api/dev/switch-user` route handler also checks the env flag at request time and returns `404 Not Found` if disabled. This ensures even if the route file ships in a production bundle, the endpoint behaves as if it does not exist.

The Entra button is always rendered. The dev panel is only rendered when the flag is on (controlled via a server-fed prop to `LoginPanel`, not an env-var read in the client).

### Middleware (`middleware.ts`)
- Matches `/dashboard`, `/forge/*`, `/api/forges/*`, `/api/conversations/*`.
- Explicitly **does not** match `/login`, `/api/auth/*` (Auth.js's own routes), or `/api/dev/*` (the dev surface manages its own gate; protecting it via middleware would prevent it from being usable for impersonation).
- Unauthenticated page request → 302 to `/login?callbackUrl=<path>`.
- Unauthenticated API request → `401 Unauthorized` JSON.

### ACL helpers (`lib/acl.ts`)
```ts
canReadForge(user, forge): boolean
  // user.isAdmin OR user.groups intersects forge.groups

canWriteForge(user, forge): boolean
  // user.isAdmin OR user.id === forge.createdById

canReadConversation(user, conversation): boolean
  // user.id === conversation.createdById  (per-user scoped)
  // future: OR conversation.isShared && canReadForge(user, conversation.forge)

forgeReadFilter(user): Prisma.ForgeWhereInput
  // for list queries — admin gets `{}`, others get groups-overlap predicate
```

### Enforcement boundary — strict rule
ACL checks live **only** inside `lib/services/*`. Route handlers, Server Components, and Server Actions call services and trust them. No duplication, no belt-and-braces. If a service returns a Forge, the caller is allowed to see it. If it throws `ForbiddenError`, the route handler maps it to 403.

### Service errors → HTTP
- `NotFoundError` → 404
- `ForbiddenError` → 403
- `ValidationError` (zod) → 400
- Anything else → 500, logged with request ID

### Login flow
1. Unauthenticated `/dashboard` → middleware → `/login`.
2. Login page → "Sign in with Microsoft Entra ID" button → `signIn('microsoft-entra-id', { callbackUrl: '/dashboard' })`.
3. Browser redirects to `login.microsoftonline.com` → user authenticates.
4. Callback to `/api/auth/callback/microsoft-entra-id` → `signIn` callback upserts local `users` row, creates session, redirects to `/dashboard`.
5. `/dashboard` Server Component calls `forgeService.list(currentUser)` → renders.

### Logout flow
Topbar dropdown's "Logout" → `signOut({ callbackUrl: '/login' })` → server-side session destroyed and cookie cleared → redirect.

## 6. Component Architecture & REST API Surface

### Folder structure (key files)
```
app/
├── (auth)/login/
│   ├── page.tsx                 # Server: shell + logo
│   └── LoginPanel.tsx           # Client: Entra btn + dev panel (env-gated)
├── (app)/                       # Auth-protected layout group
│   ├── layout.tsx               # Topbar + auth guard
│   ├── dashboard/
│   │   ├── page.tsx             # Server: forgeService.list(user)
│   │   ├── DashboardClient.tsx  # Client: search/filter/modals state
│   │   ├── ForgeCard.tsx        # presentation
│   │   ├── ForgeFormModal.tsx   # shadcn Dialog — create + edit metadata
│   │   └── DeleteConfirmDialog.tsx
│   └── forge/[id]/
│       ├── page.tsx             # Server: forge + conversations + messages
│       ├── ForgeWorkspace.tsx   # Client: two-column shell, active conv state
│       ├── ChatColumn.tsx       # Client: composer, message list, useOptimistic
│       ├── ConversationHistory.tsx
│       └── PreviewColumn.tsx    # placeholder pane
├── api/
│   ├── auth/[...nextauth]/route.ts
│   ├── forges/route.ts                 GET, POST
│   ├── forges/[id]/route.ts            GET, PATCH, DELETE
│   ├── forges/[id]/conversations/route.ts   GET (mine), POST
│   ├── conversations/[id]/route.ts     GET, PATCH, DELETE
│   ├── conversations/[id]/messages/route.ts POST
│   └── dev/switch-user/route.ts        POST (env-gated)
└── layout.tsx                   # root: fonts, providers

components/
├── ui/                          # shadcn primitives
└── topbar/Topbar.tsx + UserMenu.tsx
```

### Service-layer rules
- Only `lib/services/*` imports `lib/prisma`.
- Every service function takes `currentUser: SessionUser` as first arg, performs ACL check internally, throws typed errors.
- Route handlers and Server Components: validate input with zod, call service, map errors → HTTP, return JSON or pass to Client Component.
- Service functions return plain DTOs (`Forge`, `Conversation`, `Message` interfaces in `lib/services/types.ts`) — never Prisma's generated types.

### REST endpoints

The table below is the **end-state across all three phases**. §7 specifies which endpoints are introduced in which phase: Phase 1 ships only `GET /api/forges` (read-only dashboard), Phase 2 adds the rest of the `/api/forges/*` mutations, Phase 3 adds all `/api/conversations/*` and `/api/forges/:id/conversations/*` endpoints. The dev endpoint exists from Phase 1.

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/forges` | List forges visible to current user |
| POST | `/api/forges` | Create — creator = current user |
| GET | `/api/forges/:id` | Read single forge |
| PATCH | `/api/forges/:id` | Update name / description / groups |
| DELETE | `/api/forges/:id` | Delete |
| GET | `/api/forges/:id/conversations` | List current user's threads |
| POST | `/api/forges/:id/conversations` | New thread |
| GET | `/api/conversations/:id` | Read with messages |
| PATCH | `/api/conversations/:id` | Rename |
| DELETE | `/api/conversations/:id` | Delete |
| POST | `/api/conversations/:id/messages` | Send user message; server appends scripted assistant reply; returns both |
| POST | `/api/dev/switch-user` | Dev-only impersonation |

All endpoints validate with zod at the route boundary and enforce ACLs via the service they call.

### Sample response shapes
`GET /api/forges`:
```json
{
  "forges": [
    {
      "id": "...",
      "name": "Aquaflow Designer",
      "description": "Hydraulic modeling...",
      "status": "active",
      "tone": "navy",
      "initials": "AD",
      "groups": ["Engineering", "R&D"],
      "createdBy": { "id": "...", "name": "Tom Reed" },
      "updatedAt": "2026-05-04T07:00:00Z"
    }
  ]
}
```

`POST /api/conversations/:id/messages` (body: `{ "content": "..." }`):
```json
{
  "userMessage": {
    "id": "...", "role": "user", "content": "...",
    "createdAt": "..."
  },
  "assistantMessage": {
    "id": "...", "role": "assistant",
    "content": "AI generation isn't enabled in this build. Your message has been saved.",
    "createdAt": "..."
  }
}
```

### Client data fetching
- **Initial page paint** → Server Component calls service directly; no browser network call on first load.
- **Mutations** → Client Component calls `fetch('/api/...')`, then `router.refresh()` to revalidate.
- **Chat send** → `useOptimistic` appends the user message instantly; on POST response, reconcile with server-provided user + assistant messages.
- **No TanStack Query / SWR for MVP.** Bare `fetch` + `useOptimistic` is enough; adding TanStack Query later is mechanical when real LLM streaming requires it.

### Notable choices
- REST endpoints over Server Actions — keeps the network surface visible and curl-able.
- Single `ForgeFormModal` for create + edit (no `editing` prop → create; with `editing` → edit). Closes the metadata-edit gap from the prototype.
- Service functions take `currentUser` as a parameter, never read it from a global.
- DTOs separate from Prisma types — REST and SSR consume the same shapes.

## 7. Phase Breakdown

Three phases, each independently shippable. Each will get its own implementation plan.

### Phase 1 — Spine
**Goal:** clickable end-to-end, deployable, demoable.

Scope:
- Repo scaffolded: Next.js 15 App Router, TS strict, Tailwind theme tokens, shadcn base setup, Vitest, Playwright.
- ESLint custom rule: blocks `import { prisma }` outside `lib/services/*`.
- `docker-compose.yml` with dev Postgres only.
- **Full Prisma schema and migrations** — all tables from §4, including `conversations` and `messages` even though not exercised in this phase. Single migration; cheaper than re-migrating mid-stream.
- Seed script (9 Forges, 8 groups, 3–4 dev users including admin).
- Auth.js with Microsoft Entra ID provider + Prisma adapter + dev-only Credentials provider + `/api/dev/switch-user` (env-gated).
- `middleware.ts` protecting `/dashboard`, `/forge/*`, and authenticated `/api/*`.
- Login page at full visual fidelity (both render states: prod-only Entra button, dev-with-impersonation panel).
- Topbar + UserMenu shared component.
- Read-only `/dashboard` listing seeded Forges, ACL-filtered. **No** Create / Settings / Delete buttons. **No** search / filter chips.
- `lib/services/forges.ts` (`list`, `get`), `lib/services/users.ts`, `lib/acl.ts`, `lib/errors.ts`.
- One Playwright happy path: dev-login as Maya → see her visible Forges; dev-login as admin → see all 9.

**DoD:** app boots on port 80; real Entra login works once end-to-end; dev login works; ACL filters reads correctly; Playwright happy path green.

### Phase 2 — Dashboard CRUD
**Goal:** full Dashboard functionality.

Scope:
- Search bar (client-side filter over loaded set).
- Filter chips (all / active / draft / archived).
- "New Forge" button → `ForgeFormModal` in create mode.
- "Settings" pencil button on each card → `ForgeFormModal` in edit mode (closes the prototype's metadata-edit gap).
- "Delete" button → `DeleteConfirmDialog`.
- Toast notifications via shadcn Sonner.
- `lib/services/forges.ts` extended: `create`, `update`, `delete` with ACL enforcement (creator OR admin).
- REST routes: `POST /api/forges`, `PATCH /api/forges/:id`, `DELETE /api/forges/:id`.
- Group multi-select chips in the modal.
- Validation: zod at API boundary, react-hook-form on the client.
- Optimistic UI for delete (remove card immediately; restore + error toast on failure).

**DoD:** every CRUD action works via UI; ACL violations return 403 surfaced as user-readable error toasts; full Playwright coverage of create / edit / delete happy paths; service-layer Vitest tests cover the four ACL classes (creator, admin, group member, non-member).

### Phase 3 — Forge workspace
**Goal:** chat-with-persistence MVP of the builder screen.

Scope:
- `/forge/[id]` page with two-column visual fidelity to prototype.
- Topbar with breadcrumb back to dashboard.
- **Left column — `ChatColumn`:**
  - Auto-resizing composer + send button.
  - Message list with user/assistant bubbles (`useOptimistic` for instant user-message render).
  - Conversation history dropdown ("History" button → list of user's threads in this Forge).
  - "New conversation" button.
  - Inline rename of active conversation title (click-to-edit).
  - Per-conversation delete (in the history dropdown row, with confirm).
- **Right column — `PreviewColumn`:**
  - Placeholder card with disabled state and copy: "Preview will appear here once AI generation is enabled in a future release."
  - Includes the prototype's chrome (build status pill, URL pill, device toggle) but in non-functional / disabled visual state — preserves visual fidelity without claiming function.
- `lib/services/conversations.ts` (`list/get/create/rename/delete`).
- `lib/services/messages.ts` (`send` — saves user msg + scripted assistant msg in one transaction, returns both).
- REST routes for conversations and messages.
- Scripted assistant reply: server-side artificial delay (~1.2 s) before returning, so the chat feels alive; canned text "AI generation isn't enabled in this build. Your message has been saved."
- ACL enforcement: per-user conversation visibility (URL guessing must not leak another user's conversation).

**Initial conversation on workspace open:** when a user navigates to `/forge/[id]` from the dashboard, the page loads the user's most recently updated conversation in that Forge (`ORDER BY updated_at DESC LIMIT 1`). If the user has no conversations in this Forge yet, the page auto-creates one with default title `'New conversation'` and lands the user there. This avoids an awkward "no conversation selected" empty state and matches the prototype's behaviour of always having an active thread.

**DoD:** open a forge from dashboard, send a message and see optimistic + persisted reply, switch conversations via history dropdown, create / rename / delete conversations, refresh and history is preserved, URL-tampering test confirms cross-user read is blocked.

## 8. Visual Fidelity & Tailwind Tokens

- **Colour palette** → `tailwind.config.ts` theme: `dark-blue`, `light-navy`, `gold` (DEFAULT/soft/deep), `ink` (DEFAULT/dim/faint), `bg`, `panel` (1/2/3), `border` (DEFAULT/strong), `danger`, `good`. Values lifted directly from prototype `:root` CSS variables.
- **Fonts** → `Inter` (sans), `JetBrains Mono` (mono), loaded via `next/font` with weights actually used (300/400/500/600/700, mono 400/500/600).
- **shadcn CSS variables** — override `--background`, `--foreground`, `--primary`, `--destructive`, `--border` etc. in `globals.css` to map onto Crystal Forge tokens. shadcn primitives then render in palette automatically.
- **Special-effect keyframes** stay in `globals.css` verbatim: `logoIn`, `haloIn`, `fadeUp`, `shimmerSweep`, plus the body radial-gradient stack for the app and the login stage.
- **shadcn primitives installed:** Button (variants `primary` gold gradient, `ghost`, `danger`), Dialog, DropdownMenu, Sonner, Input, Textarea, Label, Avatar, Tooltip.

Visual-fidelity verification is manual pixel-eye review against prototype HTML during each phase. No automated visual regression testing in this slice.

## 9. Testing Strategy

- **Vitest, colocated** (`Component.test.tsx` next to `Component.tsx`, `service.test.ts` next to `service.ts`).
  - Service functions tested against **real Postgres** via the dev compose database, each test wrapped in a transaction rolled back at end. No Prisma mocking. Slower CI by some seconds; worth it for truthful coverage.
  - ACL predicates and `acl.ts` filter generators get heavy coverage (creator, admin, group member, non-member combinations).
  - Component rendering + optimistic reconciliation tested with Vitest + Testing Library.
- **Playwright, `tests/e2e/`** — one happy-path spec per phase (see DoD entries). Auth bootstrapped via `/api/dev/switch-user`, not the Entra flow.
- **Type-check + lint** in CI command. Custom ESLint rule enforces `import { prisma }` only inside `lib/services/*`.
- **Single test command:** `pnpm typecheck && pnpm test && pnpm e2e`.
- **Not tested in this slice:** real Entra OIDC flow (manual smoke per phase), visual regression, performance / load.

## 10. Decision Log

Notable choices and the reasoning, captured so future-you can re-evaluate.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Next.js end-to-end (no Spring Boot) | Java backend was dropped as a requirement during brainstorm; staying in TypeScript reduces context-switching and keeps the data-flow types end-to-end |
| 2 | Per-group ACLs with creator-or-admin write rule | User picked it explicitly; preferred over per-user-only ownership for an internal tool with team-scoped Forges |
| 3 | Group memberships and admin role seeded directly in DB | No admin UI in this slice; explicit user choice |
| 4 | On-prem deployment, no Docker yet (next slice owns containerisation) | User constraint; integration with future Forges via REST only |
| 5 | Forge builder chat persists, AI is scripted, preview is placeholder | "Build twice" risk on the preview pane was unacceptable; conversations are real product data and worth persisting |
| 6 | Tailwind theme + shadcn primitives + globals.css for keyframes | Matches user's CLAUDE.md stack defaults; mechanical conversion from prototype CSS |
| 7 | Two-button card pattern `[Open] [Settings] [Delete]` | Closes the prototype's metadata-edit gap with smallest UI change; reuses existing modal |
| 8 | Per-user conversation scoping; future-friendly to read-only sharing | User asked to keep schema unblocked for that future case; current `created_by` predicate is the only enforcement, future `is_shared` flag widens it |
| 9 | Pattern Z — Server Components for SSR + complete REST API for mutations and external use | Honours user's REST-only integration philosophy without taxing first-paint; service layer is the single enforcement boundary |
| 10 | Database sessions, not JWT | Instant invalidation, fresh group memberships per request. JWT is a future option, not a planned migration |
| 11 | Dev-only Credentials provider + `/api/dev/switch-user`, gated by env | Multi-user local debugging without round-tripping through Entra |
| 12 | Real Postgres for service tests (transactions rolled back) | Mocking Prisma is lossy; testcontainer-style real DB is truthful and fast enough |
| 13 | No soft delete | Deferred. Schema-additive when added; Postgres backups cover catastrophic loss |
| 14 | No Server Actions for mutations (REST instead) | Per the network-visibility preference |
| 15 | All schema in Phase 1 (even unused tables) | One migration is cheaper than re-migrating mid-stream |

## 11. Open Questions / Assumptions to Verify

- **Entra app registration** — confirm the redirect URI `http://localhost/api/auth/callback/microsoft-entra-id` is registered, and obtain the tenant ID, client ID, client secret for local dev. Production registration likely needs a separate redirect URI when the on-prem hostname is finalised.
- **Reverse proxy in production** — out of repo scope, but the proxy must forward the `Host` header correctly so Auth.js's callback URL validation passes.
- **Postgres provisioning for production** — out of this slice, but the next slice (Docker) needs a clear story for connection strings and migrations on deploy.
- **Logging / observability** — server logs only in this slice. If structured logging or APM becomes a hard requirement, we'd add it before phase 1's DoD.
- **CI environment** — assumed available (GitHub Actions, Azure DevOps, or similar). The "single test command" assumes CI can stand up Postgres for tests via Docker; if CI cannot run Docker, we'll need a managed Postgres instance for tests.

## 12. Out of Scope

Explicit "no" for this slice (each is a future, separately-spec'd slice):

- Real LLM integration (chat is scripted; assistant message text is canned)
- Real preview generation (placeholder pane only)
- Document ingestion / RAG / pgvector
- ERP mirror / shared drive crawler
- Sandboxed code execution
- Admin UI for users / groups / roles
- Read-only shared conversations (schema-friendly, no implementation)
- Soft delete
- Docker / containerisation (next slice)
- Production reverse proxy config and ops automation
- Multi-tenant beyond Crystal Fountains
- Visual regression testing
- i18n / full WCAG audit (basic keyboard focus + semantic HTML in scope)
- Native mobile (responsive breakpoints from prototype carry over)
- Analytics / telemetry beyond server logs
