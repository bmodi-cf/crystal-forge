# Crystal Forge — Production Deployments Tab Design

- **Date:** 2026-08-13
- **Status:** Approved — ready for implementation planning
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Turn the admin **Deployments** tab in prod mode into the place where an admin sees
  every forge prod knows about, the versions available in the registry, what is running right
  now, and deploys a chosen version with one gated action. Also fixes the bug that makes the
  existing tab permanently empty.

## 0. Context & relationship to prior work

Two prior specs bracket this one:

- `2026-07-02-forge-production-deployment` built the **producer**: the pilot builds a
  production image at a pinned commit and pushes it to the on-prem registry. §0 and §7.2
  explicitly deferred everything past the registry.
- `2026-07-08-forge-prod-mode` built the **consumer**: prod mode, the declarative reconcile
  loop, and `Forge.deployEnabled` / `Forge.deployVersion` as desired state.

Neither spec ever specified **how `deployVersion` gets set**. The prod-mode spec §3 documents
exactly one mechanism — a hand-written `INSERT` — and the code matches: there are no
non-test writers to that column anywhere in the repo. The promotion flow does not touch it
either; `acceptPromotion` merges, git-tags, and retags the registry manifest, then stops.

The pipeline therefore dead-ends at the registry, with a human running `psql` as the bridge.
This spec is that bridge.

### Rejected alternative: registry polling

An auto-follow poller (prod watches the registry and deploys new tags on its own) was
considered and **rejected**. It would collapse promotion and deployment into a single gate on
the pilot, removing any prod-side control over *when* an app restarts and requiring a pin
mechanism anyway to make rollback possible. The settled split is:

| Machine | Responsibility | Gate |
| --- | --- | --- |
| **Pilot** | Promotion — build, check, and push/retag an image in the registry | Admin Accept |
| **Prod** | Deployment — choose **which** version runs and **when** it cuts over | Admin Deploy |

### Supersedes

This supersedes **§6.3 of `2026-07-08-forge-prod-mode`**, which specified the Deployments view
as read-only ("No mutations — it does not contradict the DB-managed config model"). The view
becomes the sanctioned writer of desired state. The DB-managed model is not abandoned: the UI
writes the same two columns SQL would, and the reconciler remains the only thing that starts
containers.

It also resolves the first **§11 open question** of that spec ("derive purely from the
reconciler's live state, or persist a last-reconcile summary?"). The answer is persist — for
reasons that turned out to be load-bearing, below.

## 1. The bug being fixed

The existing tab is fully built — page, client, API route, reconciler, and colocated tests —
and permanently renders "No forges are enabled for deployment." It is not a partial build.

`reconciler.ts` keeps the last tick's statuses in a module-level `let latest`, written by
`startReconcileLoop` and read by `getLatestDeploymentStatuses()`, which `/api/deployments`
calls. Turbopack emits that module into **two separate server chunks**:

| chunk | `startReconcileLoop` | `getLatestDeploymentStatuses` |
| --- | --- | --- |
| `[root-of-the-server]__06n1~51` (instrumentation) | yes | no |
| `[root-of-the-server]__04z~tl4` (loaded by `route.js`) | no | yes |

Two module instances, two independent `latest` bindings. The loop writes one; the route reads
the other, which nothing ever assigns. It returns `[]` forever.

The loop itself is healthy — `~/.crystal-forge/state.json` is rewritten every tick and the
journal shows `prod reconcile loop started` with no failures.

No unit test caught this and none could: `reconciler.test.ts` calls `statuses()` on a
directly-constructed reconciler, and `DeploymentsClient.test.tsx` mocks `fetch`. The fix is
therefore **structural, not a test gap** — removing the shared-memory assumption removes the
failure mode.

## 2. Settled decisions

| Decision | Choice |
| --- | --- |
| **Trigger** | Manual only. No polling, no auto-deploy. |
| **Pull/cutover** | **Fused.** One DEPLOY button does pull + restart, accepting downtime. Splitting them (pre-pull warm, cut over later) is a deliberate future slice — see §8. |
| **Table scope** | **Inventory**, not desired state. Every `Forge` row appears, including never-deployed ones. |
| **First deploy** | DEPLOY on a never-deployed forge sets `deployVersion` **and** `deployEnabled = true`. First deploy and upgrade are the same gesture. |
| **Rollback** | Deploy any older semver tag. No ordering restriction. |
| **No image** | Forges with no semver tags show a `no image` state with DEPLOY disabled. |
| **Status source** | Persisted snapshot written by the reconciler (§3). |
| **Action semantics** | Write desired state and return; the reconcile loop converges. No inline container work in the request. |
| **Schema** | **No change.** Reuses `deployEnabled` / `deployVersion`. |

## 3. Status persistence

New `lib/runtime/prod/deployment-status.ts`, with `deploymentsFilePath()` added to
`lib/runtime/paths.ts` → `~/.crystal-forge/deployments.json`.

`loadDeploymentStatuses()` / `saveDeploymentStatuses()` mirror `lib/runtime/state.ts` exactly:
atomic write via tmp → `fsync` → `rename`; `ENOENT` returns empty; an unparseable file is
renamed to a `.corrupt-<ts>` backup, logged, and treated as empty. A missing or corrupt
snapshot must never break the page — the table still renders inventory, with status unknown.

`startReconcileLoop`'s tick writes the snapshot after each `reconcileOnce()`. The module-level
`latest` and `getLatestDeploymentStatuses()` are **deleted**; nothing else reads them.

Persisting also means status survives a dashboard restart instead of blanking until the next
tick.

## 4. Service layer

New `lib/services/deployments.ts`. All functions admin-only, following the existing service
convention of taking `currentUser` and throwing `ForbiddenError`.

**`listDeployments(currentUser)`** — joins `prisma.forge.findMany()` (unfiltered: inventory)
against the status snapshot keyed by `forgeId`. Returns per row: `forgeId`, `name`,
`displayName`, `slug`, `deployEnabled`, `deployVersion` (pinned), `runningVersion`, `phase`,
`error`, `consecutiveFailures`.

Deliberately does **not** call the registry, so the 3s poll stays cheap and a registry outage
cannot blank the status table.

**`listAvailableVersions(currentUser)`** — for every forge row, `registry.listTags(slug)`,
keeping only tags `parseVersion` accepts, sorted descending with `compareVersions` (both
already in `lib/versioning/semver.ts`). This drops the `sha-…` candidate tags and `latest`.
Returns a `forgeId → versions[]` map.

It is a **batch** call, on a separate cadence from the status poll, for a reason: the `no
image` state (§6) disables the DEPLOY button, so the client must know a forge has no tags
*before* the admin interacts with it. Fetching tags lazily per menu-open cannot satisfy that —
it would only discover emptiness after a click on a button that should already have been
disabled. A per-forge registry failure yields `null` for that forge (distinct from `[]`, which
means "no images exist"), so one unreachable repo does not blank the whole map.

`latest` is excluded from the deploy menu on purpose: it is a moving pointer maintained by
`acceptPromotion`, and pinning to it would break the reconciler's version check — the
container label would read `latest` forever and never appear to drift even after the
underlying manifest moves.

**`deployForge(currentUser, forgeId, version)`** — validates `version` against the filtered
list for that forge, then writes `deployVersion = version, deployEnabled = true`. Validation
is what stops a POSTed `latest`, a typo, or a deleted tag from taking a forge down, since a
bad pin is not recoverable without a second deploy (§6).

## 5. Routes

All three admin-only **and** prod-only. The existing `/api/deployments` checks admin but not
`isProdMode()`; that is tightened here.

| Route | Purpose |
| --- | --- |
| `GET /api/deployments` | Inventory rows. Polled every 3s by the client. Never touches the registry. |
| `GET /api/deployments/versions` | Batch `forgeId → versions[]` map. Fetched on mount and after a deploy — **not** on the 3s status cycle. |
| `POST /api/deployments/[forgeId]/deploy` | Body `{ version }`. Writes desired state, returns immediately. |

## 6. UI, states, and deploy flow

`DeploymentsClient` becomes an inventory table: forge, pinned version, running version, status,
action.

Six states. Only three of them come from the reconciler's `phase`; the rest are derived, so the
rules are spelled out to keep the derivation unambiguous. `pinned` is the DB's `deployVersion`,
`running` is the snapshot's `runningVersion`, `versions` is this forge's entry in the batch map.

| State | Derivation |
| --- | --- |
| `not deployed` | `deployEnabled = false` or `pinned = null` — takes precedence over everything below |
| `no image` | not deployed **and** `versions` is `[]`; DEPLOY disabled |
| `deploying` | `pinned ≠ running` and `phase` is not `failed` — the loop has not converged yet |
| `running` | `phase = running` and `pinned = running` |
| `failed` | `phase = failed`; shows the reconciler's reason and `consecutiveFailures` |
| `stopped` | `phase = stopped` — enabled and pinned, but nothing running |

`deploying` covers the whole window from the POST until the tick that starts the container
completes, which can be minutes with a cold pull. During that window the snapshot still holds
the *previous* tick's values, so the row legitimately shows the old `running` version beside
the new `pinned` one. That is the intended reading, not staleness to be corrected.

If `versions` is `null` (registry unreachable for that forge, §4) the row keeps its status but
the version menu shows an error rather than an empty list — an unreachable registry must not
masquerade as `no image`.

**Flow:** click → POST → DB write → immediate return → row shows `deploying` → the loop picks
up the drift within one `FORGE_RECONCILE_INTERVAL_MS`, stops the old container, pulls, starts,
probes → the tick writes the snapshot → the 3s poll turns the row green, or red with a reason.

## 7. Failure handling

- **Bad or vanished image.** The reconciler's recreate path stops and removes the old container
  *before* starting the new one (`reconciler.ts:82-91`), and `ContainerManager` has no separate
  pull — `create()` pulls implicitly. So a failed pull leaves the forge **down** until a
  working version is deployed. This is the accepted cost of fusing pull and cutover, and the
  reason the failure reason must reach the UI. Version validation in `deployForge` (§4) is the
  main guard against entering this state by accident.
- **Repeated failure.** Hits the existing backoff cap; the row shows `failed` with the reason
  and count, and retries stop.
- **Registry unreachable.** Degrades the version menu only. Status and inventory are
  unaffected, because `listDeployments` never calls the registry.
- **Missing/corrupt snapshot.** Backed up and treated as empty; inventory still renders.
- **Non-admin or non-prod.** 404/403, matching existing route conventions.

## 8. Out of scope

- **Split pull/cutover.** Pre-pulling an image while the old container keeps serving, then
  cutting over separately, would shrink the outage to a restart and make a failed pull
  harmless. Deferred as a more advanced slice; it likely needs a `pull` method on
  `ContainerManager`.
- **Stop / undeploy control.** Setting `deployEnabled = false` remains SQL.
- **Scheduling / maintenance windows.** The gate is the admin pressing the button.
- **Image deletion / GC from the UI.** The registry supports `DELETE` (commit `6237348`), but
  note the runbook warning (`f46826c`) that `garbage-collect --delete-untagged` corrupts
  buildx OCI-index images.
- **Populating prod's `forges` table.** Prod currently has one row (Crystal Lattice); four
  more need importing from pilot. That is a separate task, though this tab is what makes those
  rows useful once they land, since DEPLOY can bring them up without SQL.

## 9. Testing

Colocated `*.test.ts(x)`, reusing the existing fake registry and Prisma test helpers.

- **`deployment-status.test.ts`** — save/load round-trip; `ENOENT` → empty; corrupt file →
  backed up, logged, empty.
- **`deployments.test.ts`** — inventory join includes never-deployed forges; semver filter and
  descending sort; `latest` and `sha-…` excluded; `deployForge` writes both columns; unknown
  version rejected; non-admin rejected; a per-forge registry failure yields `null` for that
  forge without failing the batch.
- **`DeploymentsClient.test.tsx`** — all six row states and their precedence (§6); DEPLOY
  disabled under `no image` but not under `versions = null`; version map fetched on mount
  rather than on the status cycle.

**Known coverage limit.** None of these would catch a recurrence of the §1 bundling bug, which
was cross-bundle and invisible to unit tests. The protection is structural: once the route
reads a file rather than a module-level variable, there is no shared memory left to duplicate.

## 10. Components & new work (summary)

- **Runtime:** `lib/runtime/prod/deployment-status.ts`; `deploymentsFilePath()` in `paths.ts`;
  `startReconcileLoop` writes the snapshot; delete `latest` + `getLatestDeploymentStatuses`.
- **Services:** `lib/services/deployments.ts`.
- **Routes:** rework `GET /api/deployments`; add `[forgeId]/versions` and `[forgeId]/deploy`;
  add `isProdMode` guards.
- **UI:** rework `app/(app)/deployments/DeploymentsClient.tsx`.
- **Reuse, unchanged:** `RegistryClient.listTags`, `lib/versioning/semver.ts`, the reconciler
  diff engine, `prod-runtime.ts`.
- **Schema:** none.
