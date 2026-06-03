# Forge Docker Isolation — Design

**Date:** 2026-06-03
**Status:** Approved (design); implementation plan pending

## Context & motivation

Today each forge runs as **host processes**. `lib/services/runtime.ts` clones to
`~/.crystal-forge/clones/<slug>`, `spawnLongLived`s `pnpm dev` on a host port, and
`lib/runtime/ws-server.ts` spawns the `claude` agent PTY **directly on the host** in the
clone directory. The forge's database is a per-forge DB inside the **shared**
`crystal-forge-pg` engine, reached with the **superuser** `crystal:crystal`
(`renderEnvExample` in `lib/services/forges.ts:23`).

So a forge's dev server — and, more importantly, its arbitrary-command-executing Claude
agent — share the host OS, filesystem, network, and DB superuser with the dashboard and
every other forge. The existing `block-dangerous-commands.sh` PreToolUse hook, which tries
to block references to the host `crystal_forge` database, is evidence that this shared-host
blast radius is already a known concern.

**Drivers:** security / blast-radius containment, and clean reproducible environments.
**Not primary:** resource isolation, physical DB isolation.

## Goals / non-goals

**Goals**
- Each forge's dev server **and** Claude agent run inside a per-forge Docker container — the
  agent's arbitrary code execution is sandboxed.
- The agent runs `--dangerously-skip-permissions` *because* the container is the boundary,
  enabling unattended long-running tasks.
- Each forge gets a scoped DB role; a compromised forge cannot reach the dashboard DB or
  other forges' DBs.
- Host-agnostic: identical behaviour on macOS (dev) and Ubuntu (pilot/prod).

**Non-goals (this spec)**
- Per-forge physical Postgres isolation. We keep the shared engine, hardened.
- Hard CPU/memory quotas (addable later via container limits).
- Packet-level egress allowlisting (phase 2 — see Open Questions).

## Target architecture

```
Host (Mac dev / Ubuntu prod)                 nginx (prod, 443) ── unchanged external contract
  dashboard (Next.js, host process)
    │  docker run / exec / inspect / stop  ──────────────► Docker daemon (/var/run/docker.sock)
    │  reverse-proxy → 127.0.0.1:<pubPort>  ──────────────► forge container's published dev port
    │  docker exec -it … claude (PTY)       ──────────────► agent inside forge container
    │  superuser CREATE DB/ROLE             ──────────────► crystal-forge-pg
    │
  ┌───────────────────────────────┐     crystal-forge-net (dedicated bridge)
  │ forge-<slug> container          │────────────┐
  │  • pnpm dev  (:<containerPort>) │            ▼
  │  • claude --dangerously-skip…   │       crystal-forge-pg  (shared engine, own container)
  │  • /workspace  ← named volume   │         ├─ crystal_forge   (dashboard, REVOKE PUBLIC)
  │  scoped DATABASE_URL (role only)│────────►│ forge_<slug> + role forge_<slug>_app
  └───────────────────────────────┘         └─ … (REVOKE CONNECT FROM PUBLIC)
       published port bound to 127.0.0.1 only
```

The **external** ingress (nginx → dashboard, which upgrades the terminal WebSocket and
routes `/app/<slug>/…` paths) is **unchanged**. Only the **internal** dashboard → forge hop
changes: from "host process on `127.0.0.1:<port>`" to "container with its dev port published
to `127.0.0.1:<port>`" — same shape, so the preview proxy and nginx never learn that forges
became containers.

## Locked decisions

| Area | Decision |
|---|---|
| Orchestration | Docker **CLI** behind a `ContainerManager` interface (real + fake), via the existing `childProcessRunner` |
| Agent | Inside the container via `docker exec -it … claude --dangerously-skip-permissions` |
| Filesystem | Full in-container; per-forge **named volume** at `/workspace` + shared pnpm-store volume; build inside the container |
| Database | Shared engine kept; per-forge **database + role + scoped creds**, `REVOKE CONNECT FROM PUBLIC`, reached over `crystal-forge-net` |
| Networking | Container dev port **published to `127.0.0.1:<pubPort>`** → `runtimeOrigin()` unchanged |
| Portability | Host-agnostic; only invariant is the Docker socket (`/var/run/docker.sock`) |

### Why these, briefly

- **CLI over `dockerode`/compose:** matches the codebase's "shell out through one runner,
  hide every external dep behind a fakeable interface" grain (`childProcessRunner`,
  `fake-client.ts`, `fake-provisioner.ts`). The PTY reuse is nearly free — `pty-session.ts`
  just spawns `docker exec` instead of `claude`. No new dependency. The whole test suite
  runs without a Docker daemon.
- **Per-forge volume, not pure-ephemeral:** isolation comes from the container *boundary*,
  not from data being ephemeral. A named volume is Docker-managed block storage the agent
  cannot use to escape — same security posture as ephemeral, but avoids losing uncommitted
  work and avoids multi-minute re-clone + `pnpm install` on every start. (Docker best
  practice: keep durable data in volumes, not the writable layer.)
- **Shared engine, hardened, not per-forge Postgres:** the engine stays always-up in its own
  container, so provisioning a forge DB is a millisecond `CREATE DATABASE`/`CREATE ROLE`, not
  a per-forge Postgres boot. Blast radius is contained at the SQL layer (scoped role +
  `REVOKE CONNECT FROM PUBLIC`) and the network layer (dedicated bridge, loopback-bound host
  ports). The accepted trade is *logical* rather than *physical* DB isolation.

## Component changes

### 1. `ContainerManager` (new — `lib/runtime/container/`)
Interface mirroring `DatabaseProvisioner`'s real + fake shape:
- `create(opts)` → `containerId`. opts: `image`, `name`, `labels` (`crystal-forge.forgeId`),
  `env`, `publish: { host: '127.0.0.1', hostPort, containerPort }`, `volumes` (per-forge
  workspace + shared pnpm-store), `network: 'crystal-forge-net'`, keep-alive entrypoint
  (`sleep infinity`).
- `exec(id, cmd, args, { tty?, env?, workdir? })` → exit code (one-off). Implements the
  existing `CommandRunner` shape so `clone.ts` is reused unchanged.
- `inspect(id)` → `{ running, health }`; `stop(id)`; `rm(id)`; `list({ label })` for cleanup.
- `FakeContainerManager` — in-memory, for unit + e2e tests; no daemon required.

### 2. Runtime lifecycle (`lib/services/runtime.ts`)
`doStart` keeps its structure but swaps primitives: allocate host port →
`containerManager.create(...)` (keep-alive as PID 1) → run setup **inside** the container via
a `containerExecRunner` (clone, install, prisma generate) → start `pnpm dev` as a detached
exec → probe `127.0.0.1:<pubPort>` until healthy → mark `running`. `doStop` → `stop` + `rm`.
DI gains `containerManager`; drops `spawnLongLived` / `isAlive` / `killProcess`. The
keep-alive PID 1 means a crashed dev server leaves the container up; liveness (below) catches
it via the port probe.

### 3. Runtime state (`lib/runtime/types.ts`, `state.ts`)
Replace `pid: number` with `containerId: string`; keep `port` (= published host port).
`redactPid` becomes a `containerId` redaction (it is an internal handle). Old-shape entries
are cleared by boot cleanup on first start, so no on-disk migration is needed.

### 4. Liveness & boot cleanup (`lib/runtime/runner.ts`)
Liveness = `inspect(containerId).running` **and** the existing port `probe`. `bootCleanup`
lists containers by the `crystal-forge.forgeId` label, removes orphans, then clears state.
The host-PID helpers in `process.ts` leave the runtime path.

### 5. Clone & build inside the container (`lib/runtime/clone.ts`)
Reused nearly verbatim: `ensureClone(forge, gh, runner)` already accepts a `CommandRunner`,
so we pass a `containerExecRunner` and `git clone` / `pnpm install` / `prisma generate` run
**in the container** against `/workspace` (Linux-native binaries for node-pty, esbuild,
prisma engines). `injectBasePath` still applies (path-based proxy). The GitHub installation
token is passed via **env / a credential helper**, not embedded in the clone URL, to avoid
leaking it into logs or process args.

### 6. Networking & preview proxy
`lib/runtime/proxy-target.ts` `runtimeOrigin()` **stays `http://127.0.0.1:<port>`** —
publishing the container port to loopback preserves the existing contract, so
`preview-proxy.ts` and nginx are untouched. Ports bind to `127.0.0.1`, never `0.0.0.0`. The
dashboard's own published ports (Postgres `5433`) are rebound to `127.0.0.1` so forge
containers cannot reach them via the docker gateway. Forge → DB traffic uses the
`crystal-forge-net` service name (`crystal-forge-pg:5432`), not the host.

### 7. Agent PTY (`lib/runtime/ws-server.ts`, `pty-session.ts`)
`pty-session.ts` already takes `command` / `args`; the WS server now spawns
`docker exec -it -w /workspace <containerId> claude --dangerously-skip-permissions
[--resume <sessionId>]`, and node-pty wraps the `docker exec` TTY transparently. The
container id is looked up from state by `forgeId` (extend `loadRuntimePort` →
`loadRuntimeHandle`). `claudeCredentialsEnv()` (currently a no-op that inherits the host
`~/.claude`) becomes the single seam that injects Anthropic credentials **into the
container** (via `docker exec -e` or a mounted credentials path).

### 8. Transcript watcher (`lib/runtime/transcript-watcher.ts`)
Largest net-new piece. Transcripts now live at the container's
`~/.claude/projects/<encodedCwd>/`, invisible to the host `fs.watch`. Add a
`ContainerTranscriptWatcher` that tails via `docker exec … tail -F` and reuses the existing
`parseTranscriptLine` plus the append-message / set-session-id logic. The
`startWatcher(conversationId, cwd, deps) → { stop }` contract is preserved so `ws-server.ts`
is unaffected beyond which watcher it constructs.

### 9. Per-forge database + role (`lib/db/pg-provisioner.ts`, `lib/db/types.ts`, `forges.ts`)
Extend the provisioner so that alongside `CREATE DATABASE` it also:
- `CREATE ROLE forge_<slug>_app LOGIN PASSWORD '<random>'`,
- grants that role privileges on its own database only,
- `REVOKE CONNECT ON DATABASE forge_<slug> FROM PUBLIC` (and the same on the dashboard DB) —
  the step that actually enforces isolation, since Postgres lets any role `CONNECT` to any
  database by default.

The forge's `DATABASE_URL` switches from superuser@`localhost:5433` to **role
creds@`crystal-forge-pg:5432`** (service name on the network) and is **injected into the
container at start**, never committed. The role password is **rotated on each start**
(`ALTER ROLE … PASSWORD`) so no DB secret is stored at rest. Superuser credentials never
enter a forge container. `dropDatabase` gains a matching `DROP ROLE` on forge deletion.

### 10. Runtime image
One shared `crystal-forge-runtime` image (Dockerfile in-repo): a Node base + pnpm + git + the
**pinned** `claude` CLI + the native-build toolchain. Built once by `forge-launch.sh` (or a
make target) and reused by every forge. Forge-specific dependencies install at start into the
workspace/pnpm-store volumes.

## Security model

**Contained**
- Agent filesystem access: only the `/workspace` volume; no host paths, no docker socket.
- Agent process: container namespaces; no host PID/mount access.
- DB blast radius: scoped role + `REVOKE CONNECT FROM PUBLIC` → cannot reach the dashboard DB
  or other forges' DBs even with valid creds.
- Host services: no host networking; host-published ports bound to loopback → dashboard
  (`3030`) and Postgres (`5433`) unreachable from containers.

**Residual / accepted / deferred**
- DB isolation is **logical** (SQL privileges), not physical — a Postgres CVE could in
  principle cross tenants. Acceptable for an internal tool; revisit if forges ever run truly
  untrusted third-party code.
- Outbound internet is open in phase 1 (needed for GitHub / Anthropic / pnpm). True egress
  allowlisting (GitHub + Anthropic only) is phase 2.
- `block-dangerous-commands.sh` becomes defense-in-depth, no longer load-bearing.

## Testing strategy

`FakeContainerManager` plus a fake transcript source let the entire Vitest suite and the
Playwright e2e suite run **without a Docker daemon**, mirroring the existing
`GITHUB_CLIENT_MODE=fake` and `DB_PROVISIONER_MODE=fake` patterns. Add a parallel
`FORGE_RUNTIME_MODE=docker|fake`. Existing runtime-service tests port over by swapping the
injected `containerManager`; clone tests already inject a `CommandRunner` and need no change.

## Ops & launch changes (`forge-launch.sh`, `docker-compose.yml`)

- Build the `crystal-forge-runtime` image.
- Create the `crystal-forge-net` bridge network; attach `crystal-forge-pg` to it.
- Rebind Postgres's published port to `127.0.0.1:5433`.
- Boot-cleanup of orphan forge containers when the dashboard starts.

## Rollout / phasing

1. `ContainerManager` interface + fake + runtime image + network/compose plumbing.
2. Runtime lifecycle, state shape, liveness, clone-in-container.
3. Per-forge DB role provisioning + scoped credential injection.
4. Agent PTY via `docker exec` + `--dangerously-skip-permissions` + credentials seam.
5. Container transcript watcher.
6. Hardening: egress allowlist, resource limits.

## Open questions / deferred

- **Agent GitHub push credentials:** the GitHub App installation token is short-lived
  (~1 hour), which is insufficient for long agent sessions. Resolve in phase 4 — likely a git
  credential helper inside the container that calls back to the dashboard for a fresh token,
  versus a per-session token injection.
- **Egress allowlist:** restricting outbound to GitHub + Anthropic needs an egress firewall
  or proxy sidecar; plain Docker bridge networking can't express it cleanly. Phase 6.
- **pnpm store sharing vs. per-forge `node_modules` performance** on macOS volumes — validate
  during phase 2; may need an overlay volume on `node_modules`.
