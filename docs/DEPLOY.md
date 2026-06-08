# Deployment (PILOT)

How the dashboard runs in production on the pilot host (`forge-pilot.crystalfountains.com`).
There is a single deploy on that machine.

The systemd unit and nginx config below live **outside this repo** (`/etc/systemd/system/`,
`/etc/nginx/`); this doc is the source of truth for what they should contain and why.

## Topology

```
browser ──https──▶ nginx (:443, TLS)  ──▶ 127.0.0.1:3030   Next.js dashboard (next start)
                            └─ /_forge-ws/ ─▶ 127.0.0.1:3100  runtime terminal WebSocket
```

- The dashboard runs in **production mode** (`next start`) bound to **loopback only**
  (`127.0.0.1:3030`). nginx terminates TLS and reverse-proxies to it.
- The agent terminal WebSocket server listens on `:3100` (started by `instrumentation.ts`,
  not by `next start` directly). nginx proxies `/_forge-ws/` to it — see the README
  "Pilot / deployment" section for the nginx WebSocket block.
- Per-forge runtimes are Docker containers on the `crystal-forge-net` network; their ports
  stay loopback-bound and are never exposed.

## systemd service

Unit: `/etc/systemd/system/crystal-forge.service` (system scope, `enabled`).

```ini
[Unit]
Description=Crystal Forge (Next.js production server)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=bmodi
WorkingDirectory=/home/bmodi/work/crystal-forge
# Next loads .env.local from WorkingDirectory automatically.
Environment=NODE_ENV=production
Environment=PORT=3030
Environment=PATH=/home/bmodi/.nvm/versions/node/v24.16.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Rebuild from source before every (re)start — see "Rebuild on restart" below.
TimeoutStartSec=600
ExecStartPre=/home/bmodi/.nvm/versions/node/v24.16.0/bin/node /home/bmodi/work/crystal-forge/node_modules/next/dist/bin/next build
ExecStart=/home/bmodi/.nvm/versions/node/v24.16.0/bin/node /home/bmodi/work/crystal-forge/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3030
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

Operate it with:

```bash
sudo systemctl restart crystal-forge.service     # rebuild + restart
sudo systemctl status  crystal-forge.service
sudo journalctl -u crystal-forge.service -f      # logs
```

## Rebuild on restart (why `ExecStartPre`)

`next start` serves a **prebuilt** `.next` and never compiles on its own. Without a build
step, a bare `systemctl restart` re-serves whatever was last built — so a code update that
isn't followed by `pnpm build` runs stale.

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

## Rollback

Each edit to the unit is backed up alongside it, e.g.
`/etc/systemd/system/crystal-forge.service.bak-<timestamp>`. To revert:

```bash
sudo cp /etc/systemd/system/crystal-forge.service.bak-<timestamp> /etc/systemd/system/crystal-forge.service
sudo systemctl daemon-reload
sudo systemctl restart crystal-forge.service
```
