# Deployment (PILOT)

How the dashboard runs in production on the pilot host (`forge-pilot.crystalfountains.com`).
There is a single deploy on that machine.

The systemd unit and nginx config below live **outside this repo** (`/etc/systemd/system/`,
`/etc/nginx/`); this doc is the source of truth for what they should contain and why.

## Topology

```
browser ──https──▶ nginx (:443, TLS)  ──▶ 127.0.0.1:3030   Next.js dashboard (custom server.ts via tsx)
                            └─ /_forge-ws/ ─▶ 127.0.0.1:3100  runtime terminal WebSocket
```

- The dashboard runs in **production mode** via a **custom Node server** (`server.ts`, run with
  `tsx`; the `pnpm start` equivalent) — **not** stock `next start`. The custom server runs Next
  with `dev:false` (serving the prebuilt `.next`) and additionally owns the HTTP `upgrade` handler
  that tunnels forge dev-server HMR (`/app/<slug>/_next/webpack-hmr`); `next start` has no upgrade
  handler. It's bound to **loopback only** (`127.0.0.1:3030`); nginx terminates TLS and proxies to it.
- The agent terminal WebSocket server listens on `:3100` — started by Next's instrumentation hook
  (`instrumentation.ts` → `startWsServer`), independently of the HTTP server. nginx proxies
  `/_forge-ws/` to it — see the README "Pilot / deployment" section for the nginx WebSocket block.
- Per-forge runtimes are Docker containers on the `crystal-forge-net` network; their ports
  stay loopback-bound and are never exposed.

## systemd service

Unit: `/etc/systemd/system/crystal-forge.service` (system scope, `enabled`). Installed by
`deploy/install.sh` from the checked-in source at `deploy/systemd/crystal-forge.service` —
edit that file and re-run the installer rather than hand-editing the installed copy.

```bash
./deploy/install.sh              # dashboard + backup, enable, restart
./deploy/install.sh --dashboard  # dashboard only
./deploy/install.sh --print      # show what would be installed, change nothing
```

Run it as the checkout owner, not under sudo — it resolves that user's (nvm) Node and calls
sudo itself for the privileged steps. What it installs:

| Path | What |
|---|---|
| `/etc/systemd/system/crystal-forge.service` | the unit, verbatim from `deploy/systemd/` |
| `/etc/systemd/system/crystal-forge.service.d/10-local.conf` | just `User=`, which systemd can't read from an env file |
| `/etc/default/crystal-forge` | per-machine `REPO_DIR`, `NODE_BIN_DIR`, `PORT` — **written once, never clobbered** |
| `/usr/local/bin/crystal-forge-dashboard` | `build` / `serve` wrapper (`scripts/dashboard.sh`) |
| `/usr/local/bin/crystal-forge-ensure-postgres` | pre-start DB guard (`scripts/ensure-postgres.sh`), shared with the backup unit |

The unit is a static file because the per-machine bits live in the env file. It needs the
wrappers because systemd cannot interpolate `EnvironmentFile` values into `ExecStart=` paths
(nor into `User=`/`WorkingDirectory=`), so something has to resolve `REPO_DIR`/`NODE_BIN_DIR`
*after* the env file loads. `crystal-forge-dashboard` does that, then `cd`s to the checkout
(which is why the unit has no `WorkingDirectory=` — Next still resolves `.env.local` and
`.next` relative to cwd).

### Start sequence

1. `ExecStartPre=/usr/local/bin/crystal-forge-ensure-postgres` — bring the shared Postgres
   container up and wait for its healthcheck (~60s cap). Postgres deliberately has **no**
   docker restart policy (see `docker-compose.yml`), so without this an unplanned reboot
   leaves the dashboard serving 500s against a dead DB — `DatabaseNotReachable` from Prisma.
   That happened on 2026-07-28. Idempotent; a healthy container is reused untouched. It does
   **not** run `prisma migrate deploy` — migrations stay manual so a restart can't silently
   change the schema.
2. `ExecStartPre=/usr/local/bin/crystal-forge-dashboard build` — see "Rebuild on restart".
3. `ExecStart=/usr/local/bin/crystal-forge-dashboard serve` — `server.ts` via tsx.

Operate it with:

```bash
sudo systemctl restart crystal-forge.service     # rebuild + restart
sudo systemctl status  crystal-forge.service
sudo journalctl -u crystal-forge.service -f      # logs
```

## Rebuild on restart (why `ExecStartPre`)

The custom server runs Next with `dev:false`, which serves a **prebuilt** `.next` and never
compiles on its own. Without a build step, a bare `systemctl restart` re-serves whatever was
last built — so a code update that isn't followed by `pnpm build` runs stale.

This bit us once: the service was restarted after a code update but `.next` was two days
old, so the running dashboard kept executing the pre-update behavior. Symptoms were
confusing (a forge preview's HMR WebSocket failing) because the deployed build predated the
change that removed that path.

`ExecStartPre=… next build` makes every (re)start rebuild from the working tree, keeping the
running deploy in sync with the source. It mirrors how forge containers already rebuild on
restart (the `while true; do pnpm build && pnpm start` supervisor in
`lib/services/runtime.ts`).

Consequences to know:

- **Restarts take ~1 min** (the build runs while the service is stopped: `ExecStartPre`
  happens after stop, before start). Restarts are no longer instant.
- **A failing build keeps the service down.** The build is mandatory (`ignore_errors=no`);
  with `Restart=always`, systemd retries up to its start limit, then gives up. This is
  deliberate — better than silently serving stale/broken output. To make build failure
  non-fatal (fall back to the last good `.next`), change `ExecStartPre=` to `ExecStartPre=-`.
- `TimeoutStartSec=600` exists so the build has room; the systemd default (90s) would kill a
  mid-build start.

## Dev iteration vs the service

The service is `enabled`, so **every reboot auto-starts it in production mode**, and while
active it owns `:3030` and `:3100`. Running `./forge-launch.sh` (or `pnpm dev`) on top of it
starts a second, dev-mode server that collides — `EADDRINUSE` on `:3100` (started by
`instrumentation.ts`, independent of the HTTP server). Because `Restart=always`, you cannot just kill the
process — systemd respawns it within `RestartSec`. Pick the path that matches the intent:

- **Ship latest code, no dev loop** — let the unit rebuild from the working tree and restart:
  ```bash
  sudo systemctl restart crystal-forge.service   # ExecStartPre builds current files (~1-2 min), then serves
  ```
  The build uses the **working tree**, so uncommitted edits go live too; a failing build keeps
  the service down rather than serving stale output.

- **Longer dev session (hot-reload)** — stop the unit to free the ports, then run dev; restart
  it when done so the boot scenario is preserved:
  ```bash
  sudo systemctl stop  crystal-forge.service     # frees :3030 + :3100
  ./forge-launch.sh                              # dev server with hot-reload on :3030
  # …develop…
  sudo systemctl start crystal-forge.service     # rebuild from working tree, back to prod
  ```
  `stop` does **not** `disable`: the unit is still enabled, so a reboot mid-session re-starts
  prod and re-collides. If you expect to reboot during a long dev session, `sudo systemctl
  disable crystal-forge.service` while developing and `enable` it again afterward — but always
  leave it `enabled` at the end so boot brings the app back up.

## Per-forge secrets (prod mode)

A prod forge container is immutable and disposable: it carries no volumes, and a
restart *recreates* it (`stopForgeContainer` stops **and removes**). So anything
written inside one — a hand-made `.env`, an uploaded file — is gone on the next
start, and that includes restarts you did not ask for: the reconciler recreates
a container whenever it has crashed or its `deployVersion` changed. By policy
all saved data belongs in the forge's database, so config is the one thing that
needs to survive.

Config comes from the prod host instead:

```
/etc/crystal-forge/forge-env/<slug>.env   ->   /app/.env   (read-only)
```

`/app` is where the image bakes the app, and Next's standalone server reads
`.env` from that directory at boot. The mount is a **single file** on purpose:
mounting a whole directory over `/app` hides the baked app — a host directory
empties it, and a named volume is seeded from the image once and then silently
pins that first version across later upgrades.

```bash
sudo install -d -m 0700 /etc/crystal-forge/forge-env
printf 'OPENAI_API_KEY=sk-...\n' \
  | sudo install -m 0644 /dev/stdin /etc/crystal-forge/forge-env/second-set-of-eyes.env
# restart that forge so its container is recreated with the mount
```

**Mode 0644, not 0600** — the file must be readable by whatever UID the forge's
image runs as. Bind mounts carry host ownership through numerically, so a
root-owned 0600 file is unreadable by any image with a `USER` directive (the
work-order tool runs as uid 1000 `node`; the template's images run as root).
The secret is still protected on the host: the *directory* is 0700, so only root
can reach the file. Getting this wrong fails at boot, not silently — the app
sees the file exist and then throws EACCES reading it.

- `<slug>` is the same slug used for the container name and image tag
  (`forge-<slug>`, `<registry>/<slug>:<version>`).
- **No file = no mount.** The forge starts exactly as before. A missing bind
  source would make docker create a *directory* at `/app/.env`, so the dashboard
  skips the mount unless the path is a regular file.
- **Edits need a forge restart** — env is read once at boot.
- `DATABASE_URL` is injected by the dashboard and always wins over a line in
  this file. It cannot be set here anyway: `docker-entrypoint.sh` checks it in
  shell before node starts.
- Secrets stay on this host. The pilot builds the image and never sees them, and
  nothing lands in the registry or the dashboard database.

Verify a running forge picked it up:

```bash
docker inspect forge-<slug> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ro={{not .RW}}{{"\n"}}{{end}}'
```

## Rollback

Each edit to the unit is backed up alongside it, e.g.
`/etc/systemd/system/crystal-forge.service.bak-<timestamp>`. To revert:

```bash
sudo cp /etc/systemd/system/crystal-forge.service.bak-<timestamp> /etc/systemd/system/crystal-forge.service
sudo systemctl daemon-reload
sudo systemctl restart crystal-forge.service
```
