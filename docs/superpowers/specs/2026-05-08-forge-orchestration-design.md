# Crystal Forge — Forge Orchestration (Start / Stop / Open) Design

- **Date:** 2026-05-08 (re-confirmed 2026-05-09)
- **Status:** Approved — host child process model confirmed; ready for implementation plan.
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Add Start / Stop / Open controls to each forge card. Harness clones, installs, and runs each forge as a host child process on its own port. Builds on `2026-05-08-template-webapp-and-forge-config-design.md` (a forge must be runnable before it can be orchestrated).

## 1. Summary

After a forge is created, today nothing is running. The repo exists on GitHub, the database exists in the harness's Postgres, but seeing "Welcome to Marketing Fru Fru" requires the user to clone the repo to their own laptop, install deps, and run `forge-launch.sh` themselves. The dashboard offers no way to actually *use* a forge.

This slice closes that gap with a minimal control surface — Start / Stop / Open — owned by the harness:

- Each forge card grows a status badge and buttons.
- The first Start clones the forge's GitHub repo to a managed local directory, copies `.env.example` to `.env.local`, runs `pnpm install`, and starts the Next.js dev server as a child process on an allocated port.
- Subsequent Starts skip the slow setup steps.
- Open is just a link to `http://localhost:<port>`.
- An HTTP probe keeps status honest.

The runtime is a host child process (Option A from the design discussion). Each forge is a separate `pnpm dev` process tracked by pid + port. Docker-per-forge is an explicit future migration target — not in scope here.

## 2. Goals & Non-Goals

### Goals
- A forge owner / admin can click Start on a forge card and, within 30–60 seconds for a first start (or seconds for a subsequent start), see status flip to Running and an Open button take them to a working "Welcome to {Forge Name}" page.
- Stop terminates the forge cleanly and frees its port.
- Status reflects reality: a forge that crashes outside the UI is detected and marked Crashed within ~15 seconds.
- Multiple forges run concurrently. Each gets a distinct port from a managed pool.
- Harness restart is clean — orphaned child processes from the previous run are killed on boot. No partial state survives.
- Cloning uses the existing GitHub App installation token (same auth path as Octokit). No host-level `gh auth` or SSH keys required.
- The runtime layer is mockable: tests use fakes for spawn / probe / clone, no real processes spawned.

### Non-Goals (this slice)
- No path-based URL routing (`/forges/<slug>`). Open link is the bare `http://localhost:<port>`. Reverse-proxy / Caddy work is a separate follow-up slice.
- No Dockerfile in the template, no docker-per-forge runtime. The "REST-only container" target is acknowledged as the future migration; the runtime interface is shaped to make that swap a one-module change.
- No real-time log streaming in the UI. Logs are written to a file; dashboard shows the path. A future slice may add a tail view.
- No auto-restart on crash. Crashed = Crashed until the user clicks Start again.
- No CPU / memory limits per forge.
- No multi-machine / production deploy story. Single developer machine only.
- No SSE / WebSocket push for status. Dashboard polls every 3s while open.
- No "shared install" / pnpm-store-sharing optimisation. Each forge gets its own `node_modules`. (pnpm's content-addressable global store helps anyway.)
- No long-term log retention. Log files are overwritten on each Start.

## 3. Architecture

### A. Filesystem layout

All managed state lives outside the harness repo in `~/.crystal-forge/` (overridable via `CRYSTAL_FORGE_HOME`):

```
~/.crystal-forge/
├── state.json              # {[forgeId]: RuntimeState} — atomic writes
└── clones/
    ├── marketing-frufru/   # full git clone of bmodi-cf/marketing-frufru
    │   ├── .env.local      # copied from .env.example on first Start
    │   ├── .forge.log      # combined stdout/stderr from setup + dev server
    │   └── ...             # the rest of the cloned repo
    └── ...
```

Layout choices:

- `~/.crystal-forge/` is well outside the harness repo so a stray `git add .` can't pull it in.
- Per-forge directory name is the **slug**, not the forge id. Easier to inspect manually.
- `.env.local` is created **inside the clone** because that's where Next.js looks for it. Not symlinked — just copied. The user can edit it; subsequent Starts don't overwrite.
- `.forge.log` lives alongside the clone for the same reason. Overwritten on each Start.

### B. RuntimeState shape

`state.json` is a single object keyed by `forgeId`:

```ts
type RuntimeState = {
  forgeId: string;
  slug: string;                    // for log paths and the directory name
  status: 'starting' | 'running' | 'stopping' | 'crashed' | 'setup-failed';
  pid: number;                     // child process pid
  port: number;                    // 3001..3099
  startedAt: string;               // ISO 8601
  logPath: string;                 // absolute path to .forge.log
  setupError?: string;             // only when status === 'setup-failed'
};
```

`status === 'stopped'` is represented by **the absence** of an entry in `state.json` for that `forgeId`. Keeps the file small and the "is this running?" check unambiguous.

Atomic writes: write to `state.json.tmp`, fsync, `rename`. No locking — the harness is the only writer.

### C. Module layout

```
lib/
└── runtime/                       # NEW — orchestration boundary
    ├── state.ts                   # load/save/mutate state.json (atomic, typed)
    ├── state.test.ts
    ├── ports.ts                   # allocatePort(), releasePort() over 3001..3099
    ├── ports.test.ts
    ├── clone.ts                   # ensureClone() — git clone + cp env + pnpm install
    ├── clone.test.ts              # fake git/pnpm via injected runner
    ├── process.ts                 # spawn / track / kill child processes
    ├── process.test.ts
    ├── probe.ts                   # HTTP liveness probe
    ├── probe.test.ts
    ├── runner.ts                  # background loop: probes all running forges, transitions state
    └── runner.test.ts
lib/services/
├── runtime.ts                     # NEW — service entry points (uses ACL)
├── runtime.test.ts
app/api/forges/
├── [id]/start/route.ts            # NEW — POST
├── [id]/stop/route.ts             # NEW — POST
└── runtime/route.ts               # NEW — GET (status for all visible forges)
app/(app)/dashboard/
├── ForgeCard.tsx                  # MODIFIED — status badge + buttons
└── ForgeCardRuntime.tsx           # NEW — the controls + live status row
```

### D. The clone + setup pipeline (`lib/runtime/clone.ts`)

`ensureClone(forge, githubClient)` is idempotent and called at the start of every Start:

1. If `~/.crystal-forge/clones/<slug>/.git` does not exist:
   1. Mint an installation token from the existing GitHub App auth (octokit-auth-app exposes this — `auth({ type: 'installation' })`).
   2. `git clone https://x-access-token:<token>@github.com/<repoFullName>.git ~/.crystal-forge/clones/<slug>` with stdout/stderr redirected to `.forge.log`.
   3. Immediately rewrite the remote URL to the token-less form: `git -C <dir> remote set-url origin https://github.com/<repoFullName>.git`. The token never persists in `.git/config`.
2. If `<dir>/.env.local` does not exist, `cp .env.example .env.local`.
3. If `<dir>/node_modules` does not exist, `pnpm install` (cwd = `<dir>`, output appended to `.forge.log`).
4. Run `pnpm prisma generate` (cheap, idempotent, ensures generated client matches schema).

`ensureClone` returns once the directory is ready for `pnpm dev`. Failures throw with a clear message (status flips to `setup-failed`).

The two slow paths (`git clone`, `pnpm install`) are bounded with timeouts (5 min and 10 min respectively) so a wedged subprocess can't keep status `starting` forever.

### E. Spawning the dev server (`lib/runtime/process.ts`)

```ts
function spawnDev(opts: { cwd: string; port: number; logPath: string }): { pid: number; child: ChildProcess } {
  const log = fs.openSync(opts.logPath, 'a');
  const child = spawn('pnpm', ['dev', '--port', String(opts.port)], {
    cwd: opts.cwd,
    env: { ...process.env, PORT: String(opts.port), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', log, log],
    detached: false,                 // dies with the harness
  });
  child.unref();                     // harness event loop doesn't wait on it
  return { pid: child.pid!, child };
}
```

Key points:
- `detached: false` so harness shutdown cascades. Combined with the boot-time orphan cleanup, that gives us "shutdown kills children" symmetrically.
- `child.unref()` so the harness can exit even though children are tracked. Their lifetimes are bounded by the harness process tree on POSIX.
- `--port <port>` is also set as `PORT` env for belt-and-braces — Next reads either.

`kill(pid)` does SIGTERM, waits up to 5 seconds for exit (poll `kill(pid, 0)`), then SIGKILL.

`isAlive(pid)` is `kill(pid, 0)` — throws `ESRCH` if dead, returns `true` otherwise. Used at boot to prune `state.json`.

### F. Port allocation (`lib/runtime/ports.ts`)

Pool: `3001` through `3099` (99 ports — comfortably more than concurrent forges anyone realistically runs in dev).

`allocatePort()`:
1. Read `state.json`. Compute `inUse = new Set(values.map(v => v.port))`.
2. Iterate `3001..3099`. For each candidate not in `inUse`, attempt to bind `net.createServer().listen(port)` briefly to detect *external* collisions (e.g. another app on 3001). If the bind succeeds, immediately close — that's our port. If `EADDRINUSE`, continue.
3. Return the port. If exhausted, throw `RuntimeCapacityError`.

Allocation is racy across concurrent Start calls but the per-forge service-layer lock (see §G) serialises them.

### G. Service layer (`lib/services/runtime.ts`)

```ts
export async function startForge(currentUser: SessionUser, forgeId: string): Promise<RuntimeState>;
export async function stopForge(currentUser: SessionUser, forgeId: string): Promise<void>;
export async function getRuntime(currentUser: SessionUser, forgeId: string): Promise<RuntimeState | null>;
export async function listRuntimes(currentUser: SessionUser): Promise<RuntimeState[]>;
```

Auth:
- `start` / `stop`: existing `canWriteForge` (creator + admin).
- `getRuntime` / `listRuntimes`: filter through `forgeReadFilter` so a user only sees runtime state for forges they can read. Hides the `pid` field from non-writers (don't expose unnecessary internals).

Per-forge lock: an in-memory `Map<forgeId, Promise<RuntimeState>>` ensures two simultaneous Start calls collapse onto one. Second caller awaits the first's promise. Same for Stop.

`startForge` flow:
1. Auth check. Look up the forge by id; throw if not visible.
2. Acquire the per-forge lock.
3. Inspect any existing `state.json` entry for this `forgeId`:
   - `running` or `starting` → return it unchanged (idempotent — clicking Start on something already running is a no-op).
   - `stopping` → throw `RuntimeBusyError` (Stop is in flight; user re-tries shortly).
   - `crashed` or `setup-failed` → treat as Stopped: free the entry's port back into the pool and clear the entry, then continue to step 4. (This is the "Start (retry)" UI path.)
   - No entry → continue to step 4.
4. Allocate port. Write a `starting` entry to `state.json` immediately (so the UI sees Starting on the next poll).
5. `await ensureClone(forge, githubClient)`. On failure, write `setup-failed` with the error message and release the port; throw.
6. Spawn the dev server. Update entry with the `pid` (status remains `starting`).
7. Poll the forge's port with `probe()` once per second for up to 30 seconds. On first success → flip status to `running`, return. On timeout → kill the process, mark `crashed`, free port, throw.

`stopForge` flow:
1. Auth check.
2. Acquire lock.
3. Read entry from `state.json`. If absent → return (idempotent).
4. Set status `stopping`. SIGTERM the pid.
5. Poll for exit (5s grace), SIGKILL if still alive.
6. Remove entry from `state.json`. Release port.

### H. Background runner (`lib/runtime/runner.ts`)

A single interval, started once at harness boot, that does two jobs:

1. **Boot cleanup (one-shot, before the loop starts):**
   - Read `state.json`. For every entry, `isAlive(pid)`:
     - dead → remove the entry (cleanup of a previous run's crash).
     - alive → SIGTERM the pid, wait, SIGKILL if needed, then remove the entry. The previous harness's children are not adopted; they're killed and the user re-Starts.
   - This guarantees a clean slate on every boot. Documented behaviour.

2. **Liveness loop (every 5s):**
   - For each `running` entry: `probe(port)`. Track consecutive failures per pid in memory.
   - 3 consecutive failures → mark `crashed` in state, attempt `kill(pid)` (best-effort), free port.
   - For `starting` entries older than 60 seconds without flipping to `running`: kill, mark `crashed`, free port. (Defensive against a wedged Start path.)

The runner runs in the same Node process as the Next.js server. Started from `instrumentation.ts` (Next 16's blessed entry-point for this).

### I. UI (`app/(app)/dashboard/ForgeCard.tsx` + `ForgeCardRuntime.tsx`)

Forge card gains a third row beneath name/description:

```
┌─────────────────────────────────────────────┐
│ Marketing Fru Fru             [draft]      │
│ Big flash! Big sale!                       │
│ ─────────────────────────────────────────  │
│ ● Stopped                       [▶ Start]  │
└─────────────────────────────────────────────┘
```

States and controls:

| Status | Badge | Buttons |
|---|---|---|
| Stopped (no entry) | grey ● Stopped | ▶ Start |
| starting | amber ● Starting… | (disabled) ⏹ Stop |
| running | green ● Running | ↗ Open · ⏹ Stop |
| stopping | amber ● Stopping… | (disabled) |
| crashed | red ● Crashed | ▶ Start (retry) · 📄 View log path |
| setup-failed | red ● Setup failed: {brief message} | ▶ Start (retry) · 📄 View log path |

Open: anchor to `http://localhost:<port>` (target=_blank).

View log path: copies the absolute path to clipboard. No in-UI tail this slice.

Polling: dashboard fires `GET /api/forges/runtime` every 3 seconds while mounted. `useEffect` cleanup cancels.

Buttons disabled-state: while a Start or Stop is in flight, the buttons disable for that card only.

### J. API routes

- `POST /api/forges/:id/start` → `{ runtime: RuntimeState }` on success, `{ error }` on failure.
- `POST /api/forges/:id/stop` → `{ ok: true }`.
- `GET /api/forges/runtime` → `{ runtimes: Record<string, RuntimeState> }` (filtered by ACL — only visible forges' entries appear).

All three reuse existing auth middleware (NextAuth session → `currentUser`).

## 4. Data Model

No DB schema changes. `state.json` is the only persistent store the runtime introduces.

The harness's existing tables (`forges`, etc.) are read-only from this slice's perspective. Forge metadata (name, description, repoFullName, slug) is read at Start time; once running, the runtime state is the only mutable thing.

## 5. Error Handling & Edge Cases

| Failure | Behaviour |
|---|---|
| `git clone` fails (auth, network) | Status `setup-failed`, error in state, log file written. Port released. User can retry Start. |
| `pnpm install` fails | Same — `setup-failed` with error captured. Log file has the install output. |
| `pnpm dev` exits within the 30s probe window | Probe never succeeds → kill (already dead), mark `crashed`, free port. |
| Dev server bound to a different port than allocated (user edits config?) | Probe on allocated port times out → marked `crashed`. (We pass `--port` so this only happens with deliberate config drift. Acceptable failure mode.) |
| Allocated port becomes occupied externally between allocation and spawn | Dev server fails to bind → exits → probe times out → `crashed`. Rare; user retries. |
| Two requests Start the same forge simultaneously | Per-forge lock collapses them — second await s the first's result, returns the same state. |
| Start clicked while status is `crashed` or `setup-failed` | Existing entry is treated as Stopped (port freed, entry cleared) and a fresh Start runs. See `startForge` step 3. |
| Start clicked while status is `stopping` | `RuntimeBusyError` returned; UI surfaces a brief "Stop in progress" toast and re-enables Start once polling shows the entry gone. |
| Forge ACL changes mid-run (groups removed, user demoted) | Currently running forge keeps running. Read access on Open link is checked at status-poll time. `stopForge` requires write access. |
| Harness crashes mid-Start | On next boot, orphan-cleanup kills any lingering child via pid. State is wiped for that forge. |
| Harness force-killed (SIGKILL on parent) | Children outlive the parent briefly. Boot cleanup detects them and kills via pid in `state.json`. |
| `state.json` corrupted (partial write, hand-edited) | On load: detect parse error → log loudly, **back up** to `state.json.corrupt-<ts>`, start with empty state. Manual cleanup of any zombie processes if it ever happens. |
| `~/.crystal-forge/clones/<slug>/` deleted while forge is running | Probe still succeeds (process is in memory, holding fds). Stop works (kill by pid). Next Start re-clones. |
| `state.json` references a forge that no longer exists in DB | Boot cleanup removes the entry after killing the pid. (Service `listRuntimes` would have already filtered it out.) |
| Disk full when writing log or state | Write fails → caller surfaces error → status `setup-failed` or `crashed` depending on phase. |
| User clicks Open while status is `starting` | Open button is hidden until `running` (UI table above). |
| Port pool exhausted | `RuntimeCapacityError` returned to caller; UI shows "Out of free ports — stop another forge first". |

## 6. Testing

### Unit
- `lib/runtime/state.ts` — atomic write semantics, parse errors, missing file, concurrent reader/writer simulation.
- `lib/runtime/ports.ts` — allocation skips in-use ports (both state-tracked and externally-bound), exhaustion.
- `lib/runtime/probe.ts` — success / 404 / connection refused / timeout.
- `lib/runtime/process.ts` — spawn / kill happy path with a tiny stub script (`node -e 'setInterval(...)'`), SIGTERM grace, SIGKILL escalation, isAlive after kill.
- `lib/runtime/clone.ts` — with an injected runner fake, asserts the right git/pnpm commands are issued in order, token rewriting, idempotency on second call.
- `lib/runtime/runner.ts` — boot cleanup (alive vs dead pids), liveness transition (3-failure threshold), starting-timeout escalation.

### Service
- `lib/services/runtime.ts` — using fakes for state + clone + process + probe:
  - happy-path Start writes correct entry, transitions starting → running on probe success.
  - Stop terminates and clears state.
  - Auth: non-writer cannot Start/Stop.
  - Auth: read-only user sees runtime in `listRuntimes` but with `pid` redacted.
  - Concurrent Start collapses onto one.
  - setup-failed path leaves state entry with `setupError` and frees the port.
  - Idempotent Start on already-running returns existing state.
  - Idempotent Stop on stopped is a no-op.

### E2E (Playwright)
- Create a forge (existing flow). Click Start. Wait for Running badge (timeout 60s for first start, allow long install). Click Open in a new tab — assert the welcome page renders the forge's name. Click Stop. Assert Stopped badge.
- Skip pnpm install in CI by snapshotting a clone with `node_modules` populated and pointing the test runner at `CRYSTAL_FORGE_HOME=<fixture>` (avoids 30+ second installs in tests).

### Manual
- Two forges Start concurrently, both reach Running, Open both, both render correctly on different ports.
- Kill the harness with SIGTERM mid-run. Restart. Confirm previously-running forges are gone (orphan cleanup). State is empty.
- `kill -9 <forge-pid>` from a separate terminal. Within ~15s the badge flips to Crashed.

## 7. Out-of-Scope Follow-ups

- **Path-based URL routing** (`/forges/<slug>/`) via Caddy + `basePath` in each forge — separate slice. The runtime layer doesn't change; only the Open link target and a small reverse-proxy config do.
- **Docker-per-forge runtime** (the "REST-only container" target). Migration: replace `lib/runtime/process.ts` (and parts of `clone.ts`) with a docker-driver. The service interface (`startForge` / `stopForge` / `getRuntime`) stays. Templates gain a `Dockerfile`.
- **Auto-restart on crash** with a backoff policy.
- **Real-time log tail in the UI** (likely SSE).
- **Resource limits** (cpulimit / nice).
- **Status push** (SSE / WebSocket) instead of polling.
- **Cross-machine deploy** of forges — completely different lifecycle, separate spec.
- **Forge runtime persistence across harness restarts** (adoption rather than orphan-kill). Only worth doing if harness restarts become a normal operation, which they shouldn't be in dev.

## 8. File-by-File Changes Summary

### New (harness)
- `lib/runtime/state.ts`, `state.test.ts`
- `lib/runtime/ports.ts`, `ports.test.ts`
- `lib/runtime/clone.ts`, `clone.test.ts`
- `lib/runtime/process.ts`, `process.test.ts`
- `lib/runtime/probe.ts`, `probe.test.ts`
- `lib/runtime/runner.ts`, `runner.test.ts`
- `lib/services/runtime.ts`, `runtime.test.ts`
- `app/api/forges/[id]/start/route.ts`
- `app/api/forges/[id]/stop/route.ts`
- `app/api/forges/runtime/route.ts`
- `app/(app)/dashboard/ForgeCardRuntime.tsx`, plus a corresponding test
- `instrumentation.ts` (or extend if it already exists) — boots the runner

### Modified
- `lib/env.ts` — add `CRYSTAL_FORGE_HOME` (default `~/.crystal-forge`).
- `lib/github/client.ts` — surface a way to mint an installation token for the clone helper. Either add `getInstallationToken(): Promise<string>` to the `GitHubClient` interface (with a fake implementation) or expose it via `OctokitGitHubClient` directly.
- `app/(app)/dashboard/ForgeCard.tsx` — embed `ForgeCardRuntime`.
- Tests for the dashboard / forge card to cover the new row.

### Dependencies
- No new runtime dependencies. `child_process`, `fs`, `net`, `http` are all in Node stdlib. `pg` and `@octokit/*` are already present.

## 9. Slice Sequencing

This slice depends on the **template + db slice** (`2026-05-08-template-webapp-and-forge-config-design.md`) being shipped first. Without that, there's nothing useful to clone or run.

Ship order: template + db → orchestration → URL routing polish → docker migration.
