# Reconnect surviving forges on dashboard restart

**Date:** 2026-07-20
**Status:** Design approved, pending implementation plan

## Problem

Every dashboard restart kills all running forges, forcing the operator to
manually restart each one from the Launch page once the dashboard is back up.

This is **not** caused by the forge containers being coupled to the dashboard
process. The containers are independent, daemon-managed (`docker create` +
`docker start`, no `--rm`), and survive the Node process exiting; the runtime
state is already persisted to `~/.crystal-forge/state.json` (slug, containerId,
port, repoFullName per forgeId); and both the preview proxy
(`lib/runtime/preview-proxy.ts:82-97`) and the HMR tunnel read the port from
that durable file at request time. `server.ts` has no shutdown hook.

The forges die for exactly one reason: `bootCleanup()`
(`lib/runtime/runner.ts:9-17`), invoked on every startup from
`instrumentation.ts:7`. It lists every container carrying the
`crystal-forge.forgeId` label, `docker rm -f`s all of them, and empties
`state.json` — deliberately destroying healthy, still-running containers and
starting from an empty slate. There is no reconciliation or rehydration.

Verified empirically on the pilot host (2026-07-20): with two forges running
(`crystal-lattice`, `test-certificates-tool`), a `systemctl restart
crystal-forge.service` left `docker ps` with zero forge containers and
`state.json` = `{}`.

## Goal

On startup, **reconcile** persisted runtime state against what Docker actually
has, so forge containers that survived the dashboard going away are adopted back
as `running` and become reachable again immediately (via the existing
file-backed proxy/HMR lookups) — no manual restart. Genuinely-dead containers
and stale state entries are cleaned up.

Non-goals (YAGNI — deferred):

- **Proactive token refresh.** The git-token refresher is an in-memory `Map`
  keyed by containerId (`lib/runtime/token-refresher.ts:45`), populated via
  `acquire()`. It starts empty after a restart; adopted forges keep whatever
  token was last written into the container and re-arm the refresher lazily on
  the next agent run, exactly as today.
- **Live transcript re-attach.** Transcript watchers are in-memory and
  per-conversation; transcripts themselves are files inside the container, so
  history survives and streaming re-attaches when the conversation is next
  opened.
- **Clean-slate escape hatch.** No env flag to force the old destroy-all
  behavior. If a clean slate is ever needed, stop forges from the UI or
  `docker rm` them by hand.

## Key facts grounding the design

- **`state.json` is durable and file-backed.** `lib/runtime/state.ts`
  (`loadState`/`saveState`/`mutateState`) does atomic read-modify-write of
  `~/.crystal-forge/state.json`. A corrupt file is backed up and treated as `{}`
  (`state.ts:21-27`). Entry shape: `RuntimeStateEntry` in
  `lib/runtime/types.ts:8-32` — `{ forgeId, slug, status, containerId, port,
  startedAt, logPath, repoFullName?, setupError? }`, keyed by forgeId.
- **Containers carry the forgeId label.** Set at creation
  (`lib/services/runtime.ts:157`, `labels: { 'crystal-forge.forgeId': forgeId
  }`) and the name is `forge-<slug>` (`runtime.ts:155`).
- **The container-manager API is thin** (`lib/runtime/container/types.ts`):
  - `list({ label })` → `ContainerSummary[]` = `{ id, name, labels }`, using
    `docker ps -a` so it includes **stopped** containers. Gives us forgeId (from
    the label) and slug (from the name) directly, but **no** running state and
    **no** port.
  - `inspect(id)` → `ContainerStatus` = `{ exists, running }`. **No port, no
    start time.**
- **The liveness loop is already non-destructive** (`runner.ts:35-53`,
  `makeLivenessChecker`): it only flips a `running` entry to `crashed` when its
  container is no longer running; it never removes a container. So marking an
  adopted forge `running` is safe — the loop will monitor it correctly.
- **allocatePort excludes ports already in `state.json`** (`ports.ts:7-17`,
  `runtime.ts:329-330`). Reconcile runs in `register()` before the server serves
  and before any new forge start, so adopted ports are recorded first and
  new-forge allocation cannot collide.

## Design

### Overview

Replace `bootCleanup()` with `reconcileForges()`, called from the same line in
`instrumentation.ts`. The only interface change is a one-field extension to
`ContainerManager.inspect()` so it can also return the published host port,
needed only by the orphan-adopt path below.

### Container-manager extension

Extend `ContainerStatus` to `{ exists: boolean; running: boolean; port?: number
}`. `DockerContainerManager.inspect()` reads the `3000/tcp` host-port binding via
a `docker inspect -f` template (e.g. `{{ (index (index .NetworkSettings.Ports
"3000/tcp") 0).HostPort }}`), parsing to a number when present and leaving
`port` undefined when there is no binding. `running` continues to come from
`.State.Running`. Callers that ignore `port` are unaffected.

The common reconcile path does **not** use `port` (it comes from the existing
state entry); only orphan adoption reads it.

### `reconcileForges()` algorithm

1. `containers = await mgr.list({ label: FORGE_LABEL })` — all labeled
   containers, running and stopped, each with `id`, `name` (`forge-<slug>`), and
   `forgeId` from `labels[FORGE_LABEL]`.
2. For each, `await mgr.inspect(id)` for `{ running, port? }`.
3. `const state = await loadState()`.
4. Build the reconciled state file by case:

   | Situation | Action |
   |---|---|
   | Container **running**, state entry exists for its forgeId | Keep the entry; set `status = 'running'`. Port stays from the entry. |
   | Container **running**, **no** state entry (state lost/corrupt/wiped) | **Adopt**: `forgeId` from label; `slug` + `repoFullName` from `forgeLookup(forgeId)` (DB — the canonical source; the `forge-<slug>` name is not trusted for this); `port` from `inspect`; `logPath` from `paths` for that slug; `startedAt = now`; `containerId = id`; `status = 'running'`. |
   | Container running, no entry, **`forgeLookup` returns null** (forge deleted) | `await mgr.remove(id)` — cannot safely serve an unknown forge. |
   | Container **not running** (exited leftover) | `await mgr.remove(id)`; drop any state entry for its forgeId. |
   | State entry whose forgeId matches **no** listed container | Drop the entry. |

5. `await saveState(reconciled)`.

`remove()` failures are caught and logged (as `bootCleanup` does today) so one
bad container can't abort the whole reconcile.

### Data flow after reconcile

Adopted/kept entries are `running` in `state.json`. The preview proxy and HMR
tunnel resolve their ports from that file, so the running apps are reachable as
soon as the dashboard is serving. The liveness loop (started immediately after
in `register()`) monitors them and only marks `crashed` if a container later
dies.

## Components touched

- `lib/runtime/container/types.ts` — add `port?: number` to `ContainerStatus`.
- `lib/runtime/container/docker-container-manager.ts` — `inspect()` also parses
  the published host port.
- `lib/runtime/runner.ts` — replace `bootCleanup` with `reconcileForges`,
  keeping an injectable `deps`: `{ containerManager?, forgeLookup? }`, where
  `forgeLookup(forgeId) => Promise<{ slug: string; repoFullName: string } |
  null>` wraps a Prisma read so tests need no real DB. `makeLivenessChecker` /
  `startLivenessLoop` are unchanged.
- `instrumentation.ts` — call `reconcileForges()` in place of `bootCleanup()`
  (same try/catch position). Wire the real `forgeLookup` to a forge service /
  Prisma read.

## Testing

Unit tests for `reconcileForges` with a fake `ContainerManager` and fake
`forgeLookup`, one per row of the case table plus the empty/no-op case:

1. running + existing entry → entry kept, `status = 'running'`.
2. running + no entry, `forgeLookup` hit → entry adopted with port from
   `inspect` and repo/slug from lookup.
3. running + no entry, `forgeLookup` null → container removed, no entry created.
4. exited container + entry → container removed, entry dropped.
5. exited container + no entry → container removed.
6. entry with no matching container → entry dropped.
7. empty list + empty state → no-op, no removes.

`inspect()` port parsing gets its own unit test (binding present → number;
absent → undefined).

Manual / e2e on the pilot host — the **2-on / 2-off** scenario: with two forges
running and two stopped, restart `crystal-forge.service` and assert the two
running containers survive and reappear as `running` in `state.json` and on the
Launch page, while the two stopped ones stay absent.

## Out of scope

Proactive token refresh, live transcript re-attach across restart, and any
clean-slate env hatch (see Non-goals).
