---
name: forge-launch
description: Use when the user invokes /forge-launch or asks to "launch", "start", or "boot" the Crystal Forge dev environment. Delegates to ./forge-launch.sh, which brings up Docker, the Postgres container, applies Prisma migrations, optionally seeds, then runs the Next.js dev server. Prints the local URL in a bordered box once ready.
---

# /forge-launch — start the Crystal Forge dev stack

Delegate to `./forge-launch.sh` in the repo root. The script handles Docker daemon startup (macOS), the Postgres container, the healthcheck wait, `prisma migrate deploy`, and `exec pnpm dev`. Your job is the judgment around it: don't disrupt a running stack without confirming, decide if `--seed` is wanted, and surface real errors verbatim.

Working directory must be `/home/bmodi/work/crystal-forge` (the pilot host is Linux). If `forge-launch.sh` isn't present at the repo root, stop and tell the user.

## Phase 0 — Is the systemd production service already running? (CHECK THIS FIRST)

On the pilot host the app runs under a systemd unit, **`crystal-forge.service`**, which is
`enabled` (auto-starts on every boot) and rebuilds from the working tree on each start. When
it's active it **already owns both `:3030` and `:3100`** (the runtime WebSocket server, started
by `instrumentation.ts`). Running `forge-launch.sh` on top of it starts a *second*, dev-mode
server that collides — you'll see `EADDRINUSE` on `:3100` (and `:3030`). This is the most common
launch failure, so check it before anything else:

```bash
systemctl is-active  crystal-forge.service   # active  => app already up in prod
systemctl is-enabled crystal-forge.service   # enabled => will auto-start on reboot
```

If the service is **active**, the app is already serving on `http://localhost:3030`. Do **not**
silently launch a dev server over it. Ask the user which path they want (these are the two real
intents — pick based on what they said, otherwise ask):

- **Path A — ship latest (no dev iteration).** They just want the running deploy updated to the
  current code. The unit's `ExecStartPre` rebuilds from the **working tree** on every start, so:
  ```bash
  sudo systemctl restart crystal-forge.service   # rebuild (~1-2 min downtime) + serve
  ```
  No `forge-launch.sh`, no dev server. Note the build uses the working tree, so *uncommitted*
  edits go live too — and a failing build keeps the service down (won't serve stale output).

- **Path B — longer dev session (hot-reload).** They want to iterate with `pnpm dev`. The
  service holds the ports and `Restart=always` means killing the process just respawns it, so you
  must **stop the unit first**, then launch dev:
  ```bash
  sudo systemctl stop crystal-forge.service      # frees :3030 + :3100
  ./forge-launch.sh                              # dev server, hot-reload, on :3030
  ```
  **`stop` does not `disable`** — the service is still `enabled`, so a reboot mid-session will
  auto-start prod again and re-collide. When the dev session ends, restore the boot scenario:
  ```bash
  sudo systemctl start crystal-forge.service     # rebuild from working tree + back to prod
  ```
  If they expect to reboot during a long session and want to stay in dev, offer
  `sudo systemctl disable crystal-forge.service` now and `enable` again when done — but always
  leave it `enabled` at the end so boot still brings the app up.

If the service is **inactive** (e.g. someone already stopped it for dev work), continue to Phase 1
and launch normally. See `docs/DEPLOY.md` for the full unit definition and rationale.

## Phase 1 — Detect what's already running

Run in parallel before invoking the script:

- **Postgres container**: `docker ps --filter name=crystal-forge-pg --format '{{.Names}} {{.Status}}'`
- **Dev server on :3030**: `lsof -nP -iTCP:3030 -sTCP:LISTEN | tail -n +2`

Decide:
- **Dev server already on :3030**: the script will hard-fail at its port-collision check (`forge-launch.sh:70-72`). Ask whether to (a) reuse the running server and just print the URL, or (b) stop it and re-launch. Default suggestion: reuse.
- **Postgres up, dev server down**: fine — the script detects the healthy container and reuses it.
- **Neither running**: proceed.

If the user wants to restart the dev server, kill cleanly: `kill <pid>` from `lsof` (never `kill -9` unless a graceful kill failed). Don't touch Postgres unless the user explicitly asks — `docker compose down -v` would wipe the `crystal-forge-pgdata` volume.

## Phase 2 — Decide on --seed

The script accepts `--seed`, which runs `pnpm db:seed`. **The seed wipes all seeded tables (forges, users, groups, conversations, …) before re-inserting**, so any forges the user created manually will be destroyed.

Pass `--seed` only if:
- The user explicitly asked ("with seed", "fresh data", "reset the demo data").
- It's the first launch and the seeded tables are empty.

If unsure, ask once. Don't pass it speculatively.

## Phase 3 — Run the launch script

From the repo root:

```bash
./forge-launch.sh           # or: ./forge-launch.sh --seed
```

Run with Bash `run_in_background: true` and capture the task id. The script ends in `exec pnpm dev`, so the background task stays alive until the dev server is stopped.

Wait for the ready signal in a separate background Bash job:

```bash
until grep -qE "Ready in|Error|error:" <output-file>; do sleep 0.5; done
```

If the script exits early, read the output and surface the actual message verbatim. Don't retry blindly. Common script failures and the user-facing fix:

| Script error | Fix |
|---|---|
| `Docker daemon is not running` (non-mac) | User starts their runtime (OrbStack, Colima) manually. |
| `Port 3030 is already in use by PID X` | Should have been caught in Phase 1 — re-do the detection. |
| `EADDRINUSE … :3100` (from `lib/runtime/ws-server.ts` via `instrumentation.ts`) | The systemd prod service is already running and owns `:3100`. Should have been caught in Phase 0 — `systemctl stop crystal-forge.service` first (Path B), then relaunch. |
| `network crystal-forge-net … incorrect label` (Compose) | A stale, unlabeled Docker network is blocking Compose. If `docker network inspect crystal-forge-net` shows **no attached containers**, `docker network rm crystal-forge-net` (Compose recreates it). Don't remove it if anything is attached. |
| `.env.local missing` | Tell user to copy `.env.example` and fill in secrets. |
| `node_modules missing` | Tell user to run `pnpm install`. |
| `Postgres did not become healthy` | Surface the `docker logs --tail 50 crystal-forge-pg` output the script already printed. |

## Phase 4 — Announce the URL

The script prints its own "starting dev server" banner before handing off to `pnpm dev`. Once `Ready in` appears in the dev-server output, open the app in the default browser, then print a separate **ready** banner. The script's port check guarantees the URL is `http://localhost:3030`.

Open the URL automatically (macOS `open`; the script only auto-starts Docker on macOS, so this matches the supported launch path):

```bash
open http://localhost:3030
```

If `open` fails (e.g. a non-macOS host), don't treat it as a launch failure — just note the URL in the banner so the user can open it manually. Then print:

```
╔══════════════════════════════════════════╗
║                                          ║
║   🔨  Crystal Forge is ready             ║
║                                          ║
║   →  http://localhost:3030               ║
║                                          ║
╚══════════════════════════════════════════╝
```

Then a single follow-up line giving the user the background task id so they know how to stop the stack (`TaskStop <id>` or close the session). Nothing else — no phase summary, no checklist.

## Failure handling

- Surface errors from the script (Docker, Postgres logs, `prisma`, `pnpm dev`) verbatim. Don't paraphrase.
- Never `rm -rf node_modules`, `docker volume rm crystal-forge-pgdata`, or `prisma migrate reset` to "fix" a launch failure. Those destroy state. Diagnose first, ask second.
- If a different Postgres is bound to :5433 (not `crystal-forge-pg`), stop and ask — do not try to take the port.
