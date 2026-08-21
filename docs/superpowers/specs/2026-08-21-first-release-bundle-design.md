# Crystal Forge — First-Release Bundle Design

- **Date:** 2026-08-21
- **Status:** Draft — awaiting review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Move a forge's **inventory row** and its **pilot data** from pilot to prod over the
  container registry, applied from the prod dashboard UI, once, on a forge's first release.

## 0. Context & relationship to prior work

Three prior specs bracket this one:

- `2026-07-02-forge-production-deployment` built the **producer**: the pilot builds a
  production image at a pinned commit and pushes it to the on-prem registry.
- `2026-07-08-forge-prod-mode` built the **consumer**: prod mode, the declarative reconcile
  loop, and `Forge.deployEnabled` / `Forge.deployVersion` as desired state.
- `2026-08-13-prod-deployments-tab` made the Deployments tab the sanctioned writer of desired
  state, and explicitly deferred **populating prod's `forges` table** (§8): *"Prod currently
  has one row (Crystal Lattice); four more need importing from pilot. That is a separate
  task."*

Between them, exactly one of the three things a first release needs can cross the pilot→prod
gap on its own:

| What must cross | Today | After this spec |
| --- | --- | --- |
| App image | Registry, via promote-gates + Accept | unchanged |
| Forge inventory row | hand-written `INSERT` on the prod host | carried in the bundle |
| Pilot data | `pg_dump` → copy → `psql` by hand | carried in the bundle |

Both remaining gaps are closed the same way and by the same artifact, because they are the
same problem: state that exists on pilot and must reach prod, over a channel that is only ever
the registry.

### Motivating case

Engineering validated **Second Set of Eyes** on the pilot using real projects, and want that
data in production at v1.0.0. SSE is a clean fit for a database-only bundle: it stores no file
bytes. `ReviewDocument` holds `fileId` / `name` / `relativePath` and the PDFs are fetched live
from Floworks, so a `pg_dump` captures the whole of its state.

### Rejected alternative: seed data inside the app image

Putting the `.sql` into the v1.0.0 app image was considered and **rejected** on three grounds,
the first being decisive:

1. **There is no good way to get the data into the build context.** The image is built by
   `promote-gates.yml` from the repo checkout. Baking in a seed means either committing real
   project data to the GitHub repo permanently, or building the release image outside the
   gated pipeline — which breaks the "the image the gates tested is the image that ships"
   chain both prior specs rely on.
2. **The entrypoint runs many times, not once.** `makeReconciler` recreates a container
   whenever the running version does not match desired, or it is not up, with retry and
   backoff. Seed-on-start would be only as safe as its marker check, and a rollback to v1.0.0
   — the normal reason to keep an old tag — would re-run a seed-bearing image against a
   database holding real production writes.
3. **Baking freezes the snapshot at build time**, when what is wanted is a snapshot at
   cutover time, since engineering keep using pilot until the switch.

### Non-goal: ongoing sync

This is a **first-release** mechanism. It deliberately cannot run twice (§5). Continuous or
repeated pilot→prod data movement is out of scope and should not be built on top of this
without its own design.

## 1. The bundle

A bundle is a normal image manifest pushed to its **own repo**, `<slug>-seed`, tagged with the
release version — e.g. `second-set-of-eyes-seed:v1.0.0`. Its single layer is a tar of three
files:

| File | Contents |
| --- | --- |
| `forge.json` | The inventory row: `name`, `displayName`, `description`, `slug`, `deployVersion` |
| `data.sql` | `pg_dump --no-owner --no-privileges` (plain format) of the pilot forge database |
| `bundle.json` | Provenance and guards: source host, cut-at, app image digest, `_prisma_migrations` fingerprint |

### 1.1 Why its own repo

Independent lifecycle. The seed repo can be deleted wholesale after cutover without touching
the app image's blobs — which matters given the runbook warning (`f46826c`) that
`garbage-collect --delete-untagged` corrupts buildx OCI-index images. It is also what makes
**discovery** possible on prod (§3.1): prod has no `Forge` row for an un-imported forge, so
the registry catalog is the only place it can learn the forge exists.

### 1.2 Why registry blobs, not `docker build`

The bundle is pushed and read as blobs through `RegistryClient`, which already speaks this API
(`http-client.ts` performs manifest GET/PUT for `tagManifest`). It gains blob put/get and a
manifest PUT.

- No `docker build` on pilot, which also sidesteps the buildx OCI-index problem already hit on
  the forge prod image (retag-to-amd64-child).
- No new `ContainerManager` surface on prod. It has `exec` but no copy-out, and its `exec`
  exposes only *combined* stdout/stderr via `logPath`.
- `fake-client.ts` makes the whole path unit-testable with an in-memory blob store.
- It remains a valid manifest, so `docker pull` works as a manual fallback and for inspection.

### 1.3 Dump format and ownership

The dump is **plain format**, restored with `psql`. Two constraints drove this:

- `pg_dump`'s default `COPY … FROM stdin` blocks cannot be executed by node-postgres, which is
  the dashboard's only in-process DB access (`pg-provisioner.ts`). But `scripts/pg-backup.sh`
  already establishes the house pattern of `docker exec -i crystal-forge-pg pg_dump …` using
  local socket trust inside the container, and prod's Postgres is containerised the same way.
  With `psql` available on both sides, plain format is strictly better than `--inserts`:
  faster, smaller, no giant statement string in Node, and consistent with
  `scripts/pg-restore-runbook.md`.
- **The restore must connect as the app role.** `provisionRole` grants only
  `ALL ON SCHEMA public` — no privileges on *existing* tables. This is invisible today because
  `prisma migrate deploy` runs as the app role from inside the container, so the app role owns
  every table it creates. Restoring as a superuser would leave the app role with schema rights
  but no table rights, and later migrations could not `ALTER` tables it does not own.
  `--no-owner` stops the dump reasserting pilot ownership.

  Concretely, the restore is `psql` **inside** the Postgres container (as `pg_backup.sh` does),
  but connected over TCP as the app role rather than over the trust socket as the superuser:
  `docker exec -i <pg> psql "postgresql://<role>:<pw>@localhost:5432/<db>"`, using the password
  set moments earlier in step 3 of §3.2.

Dumping runs through a small `lib/db/dump.ts` that spawns the command directly rather than
going through `ContainerManager` — that abstraction is for forge containers, and its combined
stdout/stderr would corrupt a dump the moment `pg_dump` emitted a warning.

## 2. Pilot side — cutting a bundle

Surface: **`app/(app)/admin/promotions`**, as an action on a forge whose promotion is
`accepted`.

**Preconditions**, all enforced server-side:

- Admin, and `FORGE_DASHBOARD_MODE=dev`.
- The forge has exactly **one** `accepted` promotion. That is what "first release" means, and
  it is already a fact in `promotion_requests`.
- **Migration parity.** The pilot database's applied `_prisma_migrations` must be a subset of
  `prisma/migrations/` in the repo *at the released commit*, which the GitHub client can list
  at a sha. If pilot's dev database carries migrations the release does not have, dev has moved
  past the release and the data's schema is ahead of the image — refuse rather than ship a
  bundle that cannot be trusted. This guard can only live on pilot: it is the only side that
  can see both the database and the repo.

**Effect:** dump the forge database, tar it with `forge.json` and `bundle.json`, push to
`<slug>-seed:<version>`.

Re-cutting overwrites the tag. Pilot cannot know whether prod has already consumed a bundle,
so the once-only guard lives on prod (§5).

## 3. Prod side — importing a first release

Surface: **`app/(app)/admin/deployments`**, a new section above the existing inventory table.

### 3.1 Discovery

Prod has no `Forge` row for an un-imported forge and therefore cannot learn of it from its own
database. Candidates come from the registry catalog (`GET /v2/_catalog`), filtered to repos
ending in `-seed`, minus the forges prod already has.

### 3.2 Apply sequence

Ordered specifically so that it never races the reconciler:

1. Pull and verify the bundle; check the marker.
2. Upsert the `Forge` row from `forge.json` with **`deployEnabled: false`**.
3. `createDatabase` (idempotent) → `provisionRole` → `setRolePassword`.
4. Restore `data.sql` **connected as the app role** (§1.3).
5. Write a `_forge_seed` marker row — bundle digest, version, applied-at — **in the same
   transaction as the restore**.
6. Set `deployEnabled: true` and `deployVersion`.

The race is eliminated rather than managed. `listDesiredForges` returns only
`deployEnabled: true` rows, so the reconciler cannot see the forge until the import has
finished; step 6 is the handoff.

On the next tick the reconciler starts the container normally. `startForgeContainer`'s own
`createDatabase` throws already-exists and is caught, `provisionRole` is idempotent, and
`setRolePassword` rotates the password. The entrypoint runs `prisma migrate deploy`, finds
every migration already recorded because the dump carried `_prisma_migrations`, applies
nothing, and serves.

## 4. Schema changes

- **Prod dashboard DB:** none. The `Forge` row is written through the existing model.
- **Per-forge DB:** one table, created by the import, not by a Prisma migration (it must not
  be part of any forge's application schema):

  ```sql
  CREATE TABLE _forge_seed (
    bundle_digest text PRIMARY KEY,
    version       text        NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now()
  );
  ```

## 5. Guards

| Guard | Side | Refuses when | Reason |
| --- | --- | --- | --- |
| Admin + mode | both | non-admin; cut on prod; import on pilot | the actions are host-specific |
| First release only | cut | forge has ≠ 1 accepted promotion | already a fact in the promotions table |
| Migration parity | cut | pilot `_prisma_migrations` ⊄ repo migrations at released sha | data schema ahead of the image |
| Bundle integrity | import | layer digest ≠ manifest digest | corrupt or truncated pull |
| Version match | import | bundle version is not a tag on the app repo, or that tag's manifest digest ≠ `bundle.json`'s recorded app image digest | a seed for a version prod cannot run, or for a *different build* of that version |
| Already imported | import | `_forge_seed` present | once-only; makes rollback to v1.0.0 inert |
| Already known | discovery | prod already has the `Forge` row | not a first release |

There is deliberately **no `--force`**. Re-seeding means dropping the database by hand, which
is exactly the friction it should carry.

## 6. Failure handling

The restore runs as `psql --single-transaction -v ON_ERROR_STOP=1` with the marker insert
inside the same transaction, so the import is atomic: either data and marker both land, or the
database is untouched and the action is retryable.

- **Restore fails.** Leftover is a `Forge` row at `deployEnabled: false` — inert. Retry is
  idempotent.
- **Final enable fails.** No stuck state: the marker means the forge now appears in the normal
  inventory table, and the admin finishes with the ordinary **Deploy** button.
- **Registry unreachable.** Discovery degrades to empty; the existing inventory table and
  status are unaffected.

## 7. Components & new work

- **Registry:** blob put/get + manifest PUT on `RegistryClient`; in-memory blob store in
  `fake-client.ts`; catalog listing for discovery.
- **DB:** `lib/db/dump.ts` (spawn `pg_dump`), restore-as-role helper.
- **Services:** `lib/services/first-release.ts` — cut (pilot) and import (prod).
- **Routes:** `POST /api/promotions/[id]/bundle` (pilot); `GET /api/deployments/bundles` and
  `POST /api/deployments/bundles/[slug]/import` (prod). Both mode-guarded.
- **UI:** action on `admin/promotions`; new section on `admin/deployments`.
- **Reuse, unchanged:** the reconciler, `prod-runtime.ts`, `DatabaseProvisioner`,
  `slugToDbName` / `dbNameToRole`, `lib/versioning/semver.ts`.

## 8. Testing

Colocated `*.test.ts(x)`, following existing patterns.

- **Registry round-trip** — push and pull a bundle through `fake-client.ts`'s blob store;
  digest mismatch rejected.
- **Cut preconditions** — refuses on a second release; refuses on migration drift.
- **Import guards** — each row of §5.
- **Restore integration** — against the real `crystal_forge_test` database the vitest harness
  already provisions; asserts the app role owns the restored tables and can read and write
  them.
- **Ordering invariant** — `listDesiredForges` must not return the forge at any point before
  step 6.

## 9. Out of scope

- **Ongoing pilot→prod sync.** First release only, by construction.
- **Forges with on-disk state.** The bundle carries the database only. SSE qualifies because
  it stores `fileId` references and fetches PDFs live from Floworks; a forge that writes files
  into its container would need more, and prod containers run with `volumes: []` regardless.
- **Deleting the seed repo after cutover.** Manual, given the GC warning in §1.1.
- **Postgres version skew** between pilot and prod. Assumed equal; both are `postgres:16-alpine`.

## 10. Open question for the reviewer

**Retention of project data in the registry.** A bundle puts real engineering project data in
the registry, where it will sit until someone deletes it, reachable by anything holding pull
credentials. That is a policy decision worth making explicitly rather than inheriting: delete
the seed repo immediately after a successful import, keep it for a defined window as a
fallback, or something else.
