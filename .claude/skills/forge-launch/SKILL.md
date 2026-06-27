---
name: forge-launch
description: Use when the user invokes /forge-launch or asks to "launch", "start", or "boot" the Crystal Forge dev environment. Delegates to ./forge-launch.sh, which brings up Docker, the Postgres container, applies Prisma migrations, optionally seeds, then runs the Next.js dev server. Prints the local URL in a bordered box once ready.
---

# /forge-launch — start the Crystal Forge dev stack

Delegate to `./forge-launch.sh` in the repo root. The script handles Docker daemon startup (macOS), the Postgres container, the healthcheck wait, `prisma migrate deploy`, and `exec pnpm dev`. Your job is the judgment around it: don't disrupt a running stack without confirming, decide if `--seed` is wanted, and surface real errors verbatim.

Run from the repo root (the directory containing `forge-launch.sh`). If `forge-launch.sh` isn't present there, stop and tell the user.

**The dev server is a custom `server.ts` (run via `tsx server.ts`), NOT stock `next dev`.** It never prints Next.js's `Ready in …`. Its ready signal is the line `dashboard server listening on :3030`. Match that — not `Ready in` — when waiting for readiness.

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

Wait for the ready signal in a separate background Bash job. The signal is `dashboard server listening` (from `server.ts`), **not** `Ready in`:

```bash
until grep -qE "dashboard server listening|Error|error:|did not become healthy|already in use" <output-file>; do sleep 0.5; done
```

Then confirm the server actually responds before announcing — a healthy authed dashboard returns a `307` redirect to login:

```bash
curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3030   # expect 3xx
```

If the script exits early, read the output and surface the actual message verbatim. Don't retry blindly. Common script failures and the user-facing fix:

| Script error | Fix |
|---|---|
| `Docker daemon is not running` (non-mac) | User starts their runtime (OrbStack, Colima) manually. |
| `Port 3030 is already in use by PID X` | Should have been caught in Phase 1 — re-do the detection. |
| `.env.local missing` | Tell user to copy `.env.example` and fill in secrets. |
| `node_modules missing` | Tell user to run `pnpm install`. |
| `Postgres did not become healthy` | Surface the `docker logs --tail 50 crystal-forge-pg` output the script already printed. |

## Phase 4 — Announce the URL

The script prints its own "starting dev server" banner before handing off to `pnpm dev`. Once `dashboard server listening` appears in the dev-server output (and the `curl` above returns a 3xx), open the app in the default browser, then print a separate **ready** banner. The script's port check guarantees the URL is `http://localhost:3030`.

Open the URL automatically, trying the opener for the host in turn (this is typically a Linux/WSL host, so `wslview`/`xdg-open` apply; `open` is the macOS fallback):

```bash
(command -v wslview >/dev/null && wslview http://localhost:3030) || \
  (command -v xdg-open >/dev/null && xdg-open http://localhost:3030) || \
  (command -v open >/dev/null && open http://localhost:3030) || \
  echo "no browser opener available"
```

If no opener is available, don't treat it as a launch failure — just note the URL in the banner so the user can open it manually. Then print:

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
