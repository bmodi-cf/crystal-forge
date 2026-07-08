# Crystal Forge — Production Dashboard Mode Design

- **Date:** 2026-07-08
- **Status:** Approved — ready for implementation planning
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** A separate **production mode** for the Crystal Forge dashboard. Running on a
  distinct prod host with its own database, it **pulls pre-built forge images from the on-prem
  registry and runs them declaratively** — no git, no build, no Claude workspaces, no edit
  mode of any kind.

## 0. Context & relationship to prior work

The `2026-07-02-forge-production-deployment` spec built the **producer** half of promotion:
the pilot dashboard builds a production image from a forge repo at a pinned commit and pushes
it to the on-prem registry (`${REGISTRY_HOST}/<slug>:vX.Y.Z`), recording `imageRef` on
accepted `PromotionRequest`s. That spec explicitly deferred (§0, §7.2) the **consumer** half:
pulling images to prod, running them, and provisioning the prod database.

This spec is that consumer half, reframed as a **dashboard mode**. It reuses the existing
`ContainerManager`, `DatabaseProvisioner`, `RegistryClient`, `preview-proxy` path router, ACL,
auth, and `listForges`. It does **not** touch the dev runtime path.

## 1. Settled decisions

| Decision | Choice |
| --- | --- |
| **Mode shape** | Same codebase, deployed on the **prod host**, flipped by an env flag `FORGE_DASHBOARD_MODE=prod`. Default `dev` — the pilot is unchanged. |
| **Dashboard DB** | Prod has its **own separate dashboard database**. Users, groups, and forge-access are administered **directly in the DB** (SQL) by an admin — there is no management UI. ACL = whatever is in the prod DB. |
| **Forge app DB** | One **shared prod Postgres**, **DB-per-forge** with scoped roles, mirroring dev. Reuses the existing `DatabaseProvisioner`. |
| **What a "forge" is in prod** | A `Forge` row (slug, name, group links) carrying a **pinned image version**. |
| **Lifecycle** | **Declarative always-on.** A **reconcile loop** keeps each enabled forge running at its pinned version. No manual start/stop; admin edits the DB. |
| **Version selection** | **Pinned exact tag** per row (e.g. `v1.2.3`). Admin bumps the tag to deploy; no auto-upgrade. |
| **Edit mode** | **None.** No clone, no `pnpm install`, no `next build`, no `pnpm dev`, no Claude, no PTY/terminal, no HMR, no conversations, no promotion/create UI. |
| **Image entrypoint** | **Assumed prerequisite** (not built here): the production image's own entrypoint runs `prisma migrate deploy` then starts the production server. |
| **Implementation structure** | Approach A — a dedicated prod runtime module + reconcile loop, parallel to the untouched dev `RuntimeService`. |

## 2. Architecture

### 2.1 The mode flag

New env var:

```
FORGE_DASHBOARD_MODE: z.enum(['dev', 'prod']).default('dev')
```

Everything keys off it. Default `dev` guarantees the pilot deployment is byte-for-byte
unchanged.

### 2.2 Process wiring (`instrumentation.ts`)

Both modes keep the dashboard-DB hardening step (a separate call from `bootCleanup`) **but
diverge on runtime boot**:

- **dev** (today): `bootCleanup()` container teardown → `startLivenessLoop()` +
  `startWsServer()` (PTY).
- **prod**: `startReconcileLoop()` **only**. No WS server (no terminal), no dev liveness loop.
- **prod skips the dev `bootCleanup` container teardown** — see §5.3 (boot adoption). In prod,
  running forge containers *are* the live apps and must not be wiped on restart.

### 2.3 Custom server (`server.ts`)

The `/app/{slug}/…` preview-proxy path routing stays active in **both** modes — that is how
users reach a running app. In prod, the forge-HMR `'upgrade'` handling is skipped (production
images have no HMR socket).

### 2.4 Module layout (approach A)

```
lib/runtime/prod/
  reconciler.ts        # desired-vs-actual diff + apply; the interval loop
  prod-runtime.ts      # start/stop ONE forge container (provision DB, pull+create, probe)
  desired-state.ts     # read enabled forge rows + pinned version from the dashboard DB
```

These import existing `ContainerManager`, `DatabaseProvisioner`, `RegistryClient`, `paths.ts`,
`ports.ts`, `probe.ts`, and the runtime state file. The dev `RuntimeService` is untouched.

**Shared vs. mode-specific.** Shared: `ContainerManager`, `DatabaseProvisioner`,
`RegistryClient`, `preview-proxy`, ACL, auth, `listForges`, the runtime state file, the
`/launch` page and `/api/forges/runtime`. Prod-specific: reconciler, prod start flow, launcher
chrome, admin Deployments view, route guard.

## 3. Data model

The prod deployment uses the **same `schema.prisma` and migrations** (same codebase), pointed
at its own database. The change lands once; the dev DB ignores the new columns.

**Reuse the `Forge` model** (not a new model) so prod inherits `listForges`,
`forgeReadFilter`/ACL, group tags, tone/initials, and the launcher cards unchanged. Add two
additive columns:

```prisma
model Forge {
  // …existing…
  deployEnabled Boolean @default(false) @map("deploy_enabled")  // desired: should the reconciler run it?
  deployVersion String? @map("deploy_version")                   // pinned tag, e.g. "v1.2.3"; null = nothing to run
}
```

- **Desired state** = `deployEnabled && deployVersion != null`.
- **Image ref** is composed exactly as the promotion flow composes it:
  `${REGISTRY_HOST}/<slug>:<deployVersion>`, where `slug = slugifyForgeName(name)`. No extra
  image-repo column.
- Migration created via `pnpm db:migrate` (never hand-edited SQL).
- **Actual state** (running / version / port) is **not** a column — the reconciler reads it
  from **container labels** (`crystal-forge.forgeId` + a new `crystal-forge.version`). Desired
  (DB) and actual (Docker) stay cleanly separated.

**Admin-seeding caveat.** Because we reuse `Forge`, an admin inserting a prod row by hand must
also populate the existing `NOT NULL` columns built for the dev/GitHub flow — `initials`,
`repoFullName` (unique), and `createdById` (FK to a `User`, `onDelete: Restrict`). In prod
these are metadata only (nothing clones), but must be non-null and valid. Documented insert:

```sql
-- Seed a prod forge (admin, direct SQL). Requires an existing User id for created_by.
INSERT INTO forges (id, name, initials, repo_full_name, created_by, deploy_enabled, deploy_version)
VALUES (gen_random_uuid(), 'Acme Portal', 'AP', 'crystalfountains/acme-portal',
        '<existing-user-uuid>', true, 'v1.2.3');
-- Grant a group access via forge_groups as usual.
```

Making these columns nullable was rejected: it would ripple into dev code that assumes they
are present. Keeping them required + documenting the seed is the lower-risk choice.

**Unused-in-prod models** (`PromotionRequest`, `Conversation`, `Message`) remain in the schema
with no rows and no UI in prod. No change needed.

## 4. Per-forge prod start/stop (`prod-runtime.ts`)

### 4.1 `startForgeContainer({ forgeId, slug, deployVersion, dbName, role })`

1. **Prod DB:** `provisioner.provisionRole(dbName, role)` (idempotent) →
   `setRolePassword(role, freshPassword)` → `buildScopedDatabaseUrl(...)` against the **prod**
   Postgres. Same mechanics as dev, different Postgres host. Password rotates per (re)create,
   as in dev.
2. **Port:** `allocatePort()`.
3. **Create container** — the crux of the dev/prod difference:

   ```
   name:    forge-<slug>
   image:   ${REGISTRY_HOST}/<slug>:<deployVersion>    // Docker pulls this
   labels:  { crystal-forge.forgeId, crystal-forge.version: <deployVersion> }
   env:     PORT=3000, NODE_ENV=production, NEXT_TELEMETRY_DISABLED=1,
            FORGE_BASE_PATH=/app/<slug>, FORGE_DEV_ORIGINS, DATABASE_URL
            // NO GH_TOKEN — no git in prod
   publish: 127.0.0.1:<port> → 3000
   volumes: none                                        // no workspace vol, no Claude vol
   network: FORGE_NETWORK                               // reach prod Postgres over the container net
   command: none                                        // use the image's baked entrypoint
   ```

   The **absence of `command:`** is the key line — dev overrides it with the `pnpm dev`
   supervisor; prod lets the image's own entrypoint run (`migrate deploy` → production server,
   the assumed prerequisite in §1). There is **no `setup()` call** — no clone, no
   `pnpm install`, no Claude.
4. **Probe** the port (reuse `probe.ts`) until healthy or deadline → status `running` or
   `failed`.
5. Write the runtime **state-file entry** so the preview-proxy can route `/app/<slug>/`.

### 4.2 `stopForgeContainer(...)`

`containerManager.stop` + `remove`, then delete the state entry. The forge's **database and
its data are left intact** on the prod Postgres — disabling/stopping never destroys data; only
an explicit admin DB action would.

### 4.3 New env

- `REGISTRY_HOST` — formalize the value `promotions.ts` already reads via
  `process.env.REGISTRY_HOST` (default `registry.crystalfountains.com`).
- `FORGE_RECONCILE_INTERVAL_MS` — reconcile cadence, default ~15000.

## 5. The reconcile loop (`reconciler.ts`)

### 5.1 Where it runs

Started from `instrumentation.register()` when `FORGE_DASHBOARD_MODE=prod`, in place of the
dev liveness loop + WS server. One initial reconcile at boot, then on
`FORGE_RECONCILE_INTERVAL_MS` interval.

### 5.2 Ground truth = Docker; DB = desired

The reconciler is otherwise **stateless** — it recomputes each tick, so it self-heals after a
dashboard restart, a crash, or manual `docker` intervention. Each tick:

1. **Desired** (`desired-state.ts`): forge rows where `deployEnabled && deployVersion != null`
   → `{ forgeId, slug, deployVersion, dbName, role }`.
2. **Actual**: `containerManager.list({ label: 'crystal-forge.forgeId' })`, reading back
   `crystal-forge.forgeId` + `crystal-forge.version` + running state.
3. **Diff → actions** (per forge):
   - desired, no container → **start**
   - desired, container at **wrong version** → **recreate** (stop+remove old, start pinned)
   - desired, container exists but **not running / unhealthy** → **recreate** (crash recovery)
   - desired, running, correct version → **no-op**
   - **not** desired but container present (row disabled or deleted) → **stop + remove**
     (DB left intact)
4. Refresh the **runtime state file** to mirror what's actually running, so the existing
   preview-proxy, `loadRuntimePort`, and status API keep working unchanged.

### 5.3 Safety properties

- **Non-overlapping ticks:** an in-flight guard skips a new tick if the previous is still
  applying, so a slow image pull cannot stack reconciles.
- **Bounded parallelism:** forges reconcile with a small concurrency cap (e.g. 3) to avoid a
  thundering herd of image pulls on boot.
- **Per-forge isolation:** one forge's failure is caught, logged, recorded as `failed` for
  that forge only; the loop continues and retries next tick.
- **Failure backoff cap:** after **N consecutive failed starts** the reconciler leaves the
  forge `failed` and **stops recreating** until its `deployVersion` changes — the safety valve
  against crash-looping a broken image (bad tag, failed migration, image that won't boot).
- **Boot adoption:** prod boot does **not** run the dev `bootCleanup` teardown. The reconciler
  **adopts** existing containers by matching `crystal-forge.forgeId`/`version` labels against
  desired state, removing only genuinely-undesired ones. Running prod apps survive a dashboard
  restart untouched.
- **Version bump = ordinary reconcile:** admin edits `deployVersion`; next tick sees the
  mismatch and recreates. No separate deploy command.

### 5.4 Port allocation

Reuse `allocatePort` on first start; the published `127.0.0.1:<port>→3000` binding and the
port recorded in the state file let the proxy route `/app/<slug>/`. On restart, the reconciler
rediscovers the port from the running container's inspect data and rewrites the state file.

## 6. UI — read-only launcher & disabled edit-mode surfaces

### 6.1 Primary surface: the existing `/launch` page

`/launch` already shows only **running** forges the signed-in user can access, as cards, with
click-through to `/app/{slug}/` and a live 3s poll (`useForgeRuntimes`). In prod it becomes the
landing page: `/` → `/launch`. It works unchanged because the reconciler writes the same
runtime state file that `/api/forges/runtime` (already ACL-filtered) reads.

**No lifecycle buttons for anyone**, admins included — lifecycle is declarative (DB-driven).

### 6.2 Disabling edit-mode surfaces — two layers

1. **Chrome/nav:** the `(app)` layout + `Topbar` read `FORGE_DASHBOARD_MODE` (server-side) and
   render prod chrome — launcher only. No management "Dashboard" link, no "Request to
   Production," no create button.
2. **Hard route guard (not just hidden):** a single `assertMode('dev')` guard makes dev-only
   routes **404 in prod** so they cannot be reached directly. Covers: forge
   create/update/delete, dev start/stop, conversations/chat, PTY/WS upgrade, all promotion
   endpoints (request/accept/reject), and any GitHub-App-backed route. This enforces "no git,
   no Claude, no edit" at the HTTP boundary, not just visually.

### 6.3 Admin-only "Deployments" status view (read-only)

The launcher shows only *running* forges, so a desired-but-`failed` forge (e.g. bad
`deployVersion`) would otherwise be invisible in the UI. A minimal **admin-only** view lists
desired forges with `{ slug, pinnedVersion, actual status, failed reason }`, read-only,
powered by the reconciler's state. No mutations — it does not contradict the DB-managed config
model; it is purely operability.

## 7. Error handling & observability

- Failure modes mapped: bad/missing tag → pull fails → `failed`; DB provision fails →
  `failed`; container starts but migrate/server fails → probe times out → `failed`, then
  recreate up to the backoff cap (§5.3).
- All actions emit structured console logs:
  `[reconciler] start|recreate|stop|failed forgeId=… slug=… version=…`.
- Failed/pending state is visible in the admin Deployments view (§6.3) as well as logs.

## 8. Testing

Colocated `*.test.ts`, reusing existing fakes (`fake-container-manager`, fake provisioner,
fake registry):

- **`reconciler.test.ts`** — the diff engine: desired-not-running→start, wrong-version→
  recreate, undesired→stop, correct→no-op, crash→recreate, failure backoff cap, boot adoption
  of a pre-existing labeled container.
- **`prod-runtime.test.ts`** — the create spec asserts correct image ref; labels (incl.
  version); env has `DATABASE_URL`/`FORGE_BASE_PATH` and **no `GH_TOKEN`**; **no volumes**; **no
  `command`**; probe success→running, timeout→failed.
- **`desired-state.test.ts`** — only `deployEnabled && deployVersion != null` rows returned.
- **Route guard test** — a representative dev-only route returns 404 under
  `FORGE_DASHBOARD_MODE=prod`.
- **UI** — mode-based chrome (launcher-only in prod); admin Deployments view renders
  status/version/reason and is admin-gated.
- **Manual verification** in dev with a fake registry + fake container manager driving the
  reconciler.

## 9. Prerequisites & assumptions (not built in this slice)

1. **Production image entrypoint** runs `prisma migrate deploy` then the production server
   (the promotion-build template work; §1).
2. **Prod host Docker daemon** is logged in to the registry with the **pull** service account
   (prod-deploy spec §2.4), so `create` can pull.
3. **Prod Postgres** exists and is reachable on `FORGE_NETWORK` (mirrors dev's
   `crystal-forge-pg`).
4. **Prod dashboard database** exists (created by docker-compose/migrations on the prod host,
   same as the pilot's dashboard DB).

## 10. Components & new work (summary)

- **Schema:** `Forge.deployEnabled`, `Forge.deployVersion` (+ migration).
- **Env:** `FORGE_DASHBOARD_MODE`, `REGISTRY_HOST`, `FORGE_RECONCILE_INTERVAL_MS`.
- **Runtime:** `lib/runtime/prod/{reconciler,prod-runtime,desired-state}.ts`.
- **Boot:** `instrumentation.ts` mode branch (reconcile loop vs. dev liveness/WS; skip
  bootCleanup teardown in prod). `server.ts` skips forge-HMR upgrade in prod.
- **UI:** mode-aware `(app)` layout + `Topbar`; `/` → `/launch` in prod; admin Deployments
  view.
- **Guard:** `assertMode('dev')` on all edit-mode routes.
- **Tests:** as in §8.

## 11. Open questions

- **Deployments-view data source:** derive purely from the reconciler's live state, or persist
  a last-reconcile summary for display across dashboard restarts? (Lean: live state; a restart
  re-derives within one tick.)
- **Backoff cap value `N`** and whether a failed forge should surface the container logs tail
  in the admin view or just the reason string.
- **Local (non-DB) writable state:** if any promoted app writes to the local filesystem rather
  than Postgres, it would need a prod volume. Out of scope now; flagged so it is a conscious
  decision if such an app appears.
