# POC Isolation Hardening: Reduce Forge Blast Radius

## Context

Today, an in-forge PTY agent runs `claude` on the host with the same UID, full
filesystem access, full network access (including the host `crystal-forge-pg`
container on `:5433`), and visibility of every host process. When the agent
hits a port conflict on `:3000` or guesses the wrong `DATABASE_URL`, it can —
and has — killed the framework's own dev server and wiped the framework's
Postgres database (see incident on 2026-05-13).

Long-term plan: each forge runs inside its own container with a separate UID
and its own Postgres instance. That work is out of scope for this spec.

This spec captures the **POC-grade mitigations** that reduce blast radius
without containerization, so the system is safe enough to leave running
while the team iterates on the chat-driven workflow.

## Goals

- A subagent inside a forge cannot kill the framework's dev server.
- A subagent inside a forge cannot wipe the framework's Postgres database.
- The mitigations remain useful even when an agent is being adversarial in
  spirit (i.e., trying to "fix" what looks like a stuck port), not just
  cooperative.

## Non-goals

- Per-forge Docker / VM isolation. (Long-term plan.)
- Separate UID / sudo for the PTY. (macOS-hostile; defer to container.)
- Per-forge Postgres instances. (Single shared container is fine; per-forge
  database is the unit of isolation.)
- Network-level segregation (firewall rules, etc.).
- Defeating a determined malicious actor with shell access. POC scope.

## Mitigations (five, ordered by implementation)

### M1. Move the host framework off `:3000` to `:3030`

**Problem:** The framework's dev server defaults to `:3000`. The forge
template's `next dev` also defaults to `:3000`. When the forge's PTY agent
runs `npm run dev`, it collides and asks "what's on :3000, kill it." That
"what" is us.

**Fix:** Run the framework's dev server on `:3030`. Forge agents continue
to default to `:3000` (or whatever port their runtime allocates) and never
see us as an obstacle.

**Files:**

- `forge-launch.sh`: change `DEV_PORT=3000` → `DEV_PORT=3030`. Export `PORT`
  before the `exec pnpm dev` line so Next picks up the new port.
- `package.json` dev script: no change needed (Next reads `PORT`).
- `playwright.config.ts`: update `baseURL` and `webServer.url` if either
  hardcodes `:3000`.
- `next-auth` / Auth.js callback URLs: usually derived from request origin,
  but verify no hardcoded `localhost:3000` in auth config.
- The `forge-launch` skill (`.claude/skills/forge-launch/`): update its
  port-collision check and the "ready" banner URL.
- Anything else under `app/`, `lib/`, `tests/`, `docs/` that references
  `localhost:3000` literally and is *not* about a forge clone.

**Detection step (run before implementation):** `grep -RIn "localhost:3000"
--include='*.ts' --include='*.tsx' --include='*.sh' --include='*.json'
--include='*.md'` to enumerate references; classify each as "host" (rewrite
to 3030) or "forge clone" (leave alone — those describe the *forge's* dev
server, which stays on 3000).

**Tests:**

- E2E smoke: visit `http://localhost:3030/dashboard`, expect 200.
- Existing Playwright suite passes against the new `baseURL`.

### M2. Pass `PORT=<forge_port>` to the PTY's environment

**Problem:** Even with M1, the in-forge agent still sometimes wants to start
a dev server, and `npm run dev` still defaults to `:3000` from inside the
clone. Two forge agents working concurrently both grab `:3000`; one wins.

**Fix:** Crystal Forge already allocates a port per forge during
`startForge` (visible in `state.json` and in `useForgeRuntimes`). Pass that
port into the PTY's environment as `PORT`. Next reads `PORT` so the agent's
`npm run dev` naturally lands on the assigned port.

**Files:**

- `lib/runtime/ws-server.ts`: when calling `spawnPty`, include
  `env: { PORT: String(forgePort) }`. Look up the port by calling the
  runtime service for the conversation's `forgeId` (the same service that
  already knows the forge is `running` — `connect` requires that). Pass
  the runtime lookup in via `WsServerOpts` so tests can stub it (same
  pattern as `loadConversation`).
- `lib/runtime/pty-session.ts`: already merges `opts.env` into the spawned
  env, so no change needed once the caller passes `PORT`.

**Edge case:** if the forge isn't currently in the runtime state (stopped),
the WS connect shouldn't have succeeded anyway — `connect` requires a
running forge. So `PORT` is always known at PTY spawn time.

**Tests:**

- `lib/runtime/ws-server.test.ts`: assert that `spawnPty` is called with
  `env.PORT` set to the conversation's forge port.
- (Manual) Start two forges concurrently; verify each agent's `npm run dev`
  lands on its own assigned port without prompting for a kill.

### M3. Fix the `writeForgeFiles` template-populate race

**Problem:** `createRepoFromTemplate` returns 201 immediately, but GitHub
populates the templated files asynchronously. `writeForgeFiles` runs first,
into an empty repo (root commit), and is then *overwritten* by GitHub's
later "Initial commit" that pastes the template contents on top. Result:
the cloned forge's `.env.local` keeps the template's placeholder
`DATABASE_URL=...forge_template` instead of the per-forge dbname.

This is how an agent in a forge accidentally hits the *wrong* database
(including the host's `crystal_forge`, when paired with other env leaks).

**Evidence already gathered:** commit graph on `bmodi-cf/start-test` shows
the `chore: write .env.example` commit as a root commit (no parent), and
the `Initial commit` (GitHub's template populate) as its descendant.

**Fix:** After `createRepoFromTemplate`, poll
`repos.getContent({path: 'package.json'})` (the template ships one) with
exponential backoff (200/400/800/1600/3200 ms) until status 200. Only then
call `writeForgeFiles`. The existing 422→GET-sha→PUT retry in
`putContents` already handles the "file already exists" case correctly
once populate has finished.

**Files:**

- `lib/github/octokit-client.ts`: add a private `waitForTemplatePopulate`
  helper that calls `getContent` in a retry loop with the same backoff
  schedule already used for 404s. Call it at the *top* of `writeForgeFiles`
  (before either `putContents`).
- `lib/github/types.ts`: documentation update on `writeForgeFiles` to
  mention the populate wait.
- `lib/github/fake-client.ts`: no behavioral change needed (the fake
  doesn't model the race).

**Tests:**

- `lib/github/octokit-client.test.ts`: new case: mock the GitHub client so
  the first N `getContent` calls return 404 and the (N+1)th returns 200.
  Assert `writeForgeFiles` waits, then proceeds with successful upsert.
- `lib/github/octokit-client.test.ts`: new case: after `writeForgeFiles`
  succeeds, the final SHAs are the upserted ones, not the template's
  placeholder SHA.

### M4. Inject `.claude/settings.local.json` with `PreToolUse` hook

**Problem:** Even with M1–M3, a confused agent could still try
destructive operations (e.g., a `psql` connection to `crystal_forge`,
a `kill` against a misidentified port). Polite instructions in
`CLAUDE.md` are not load-bearing; the agent can ignore them.

**Fix:** Inject a `.claude/settings.local.json` + a `.claude/hooks/`
script into each forge clone via `writeForgeFiles`. The hook is invoked
on every `Bash` tool call by Claude Code in the forge. On a dangerous
match the hook prints a reason to stderr and exits **2** — Claude Code's
convention for "block this tool call." Deterministic, not advisory.

**Hook script (bash) — `.claude/hooks/block-dangerous-commands.sh`:**

```bash
#!/usr/bin/env bash
set -e
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")

# Block process kills — never legitimate inside a forge sandbox.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])(kill|pkill|killall)([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: kill/pkill/killall not allowed inside a forge sandbox.\n' >&2
  exit 2
fi

# Block any reference to the host database name.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])crystal_forge([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: cannot reference the host crystal_forge database.\n' >&2
  exit 2
fi

exit 0
```

**Settings file — `.claude/settings.local.json`:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/block-dangerous-commands.sh" }
        ]
      }
    ]
  }
}
```

**Files:**

- `lib/github/types.ts`: extend `ForgeFiles` with `claudeSettings: string`
  and `claudeBlockScript: string`.
- `lib/github/octokit-client.ts::writeForgeFiles`: add two more
  `putContents` calls for `.claude/settings.local.json` and
  `.claude/hooks/block-dangerous-commands.sh`.
- `lib/services/forges.ts::renderClaudeSettings()` + `renderBlockScript()`
  helpers, called from both `forges.create` and `prisma/seed.ts` to
  produce the file bodies.
- `prisma/seed.ts`: pass the two new files into `writeForgeFiles`.
- `lib/runtime/clone.ts::ensureClone`: after `git clone`, `chmod +x` the
  hook script (GitHub's `contents` API doesn't preserve the executable
  bit) so the harness can run it. Use the same pattern as the
  node-pty `spawn-helper` chmod fix from earlier.

**Tests:**

- `lib/github/octokit-client.test.ts`: assert `writeForgeFiles` writes all
  four files when given the full `ForgeFiles`.
- `lib/github/fake-client.test.ts`: ditto for the in-memory fake.
- `lib/services/forges.test.ts`: assert `forges.create` passes through
  the rendered settings and script.
- (Manual smoke) start a forge, ask the in-forge agent to `kill 1`; expect
  it to be blocked before execution.

### M5. Inject `CLAUDE.md` at the forge clone root

**Problem:** Hooks block specific dangerous commands. They don't shape
the agent's *intent*. An agent that's been told "your port is X, the host
is off-limits" makes fewer attempts at dangerous things in the first place.

**Fix:** Drop a focused `CLAUDE.md` at the clone root, rendered per forge:

```markdown
# Forge: {{name}}

You are working inside a Crystal Forge sandbox cloned to this directory.

## Sandbox rules

- Your dev server's port is **{{port}}** (from the host's runtime; do not
  override unless asked).
- Your database is **{{dbName}}**. Never touch `crystal_forge` or any
  other database that isn't `{{dbName}}`.
- Do not run `kill`, `pkill`, `killall`, or any other process-killing
  command. If a port appears in use, start your server on a different
  port instead.
- Do not modify files outside this directory.
- Long-running processes (dev server, watchers): prefer `&`-backgrounded
  with explicit `--port` flags. Read `forge.config.json` for canonical
  forge identity.

## Forge identity

See `forge.config.json` for `name`, `description`, `slug`, `dbName`,
`createdAt`.
```

Note `{{port}}` here is *informational* — the agent has the port via the
PTY env (M2) and via `forge.config.json`. The CLAUDE.md just makes the
constraint explicit in prose.

**Files:**

- `lib/github/types.ts`: extend `ForgeFiles` with `claudeMd: string`.
- `lib/services/forges.ts::renderClaudeMd(name, dbName, port?)`: produce
  the body. `port` is optional at create time (the forge isn't running
  yet); leave a `{port-from-env}` placeholder or omit the line. Most
  honest: render without a port line, since the forge's allocated port
  isn't known until first `Start`.
- `lib/github/octokit-client.ts::writeForgeFiles`: one more `putContents`
  call.
- `prisma/seed.ts`: pass the rendered claudeMd.

**Tests:** mirror M4 (write paths in real + fake; service smoke).

## Implementation order

Each phase is independently shippable; later phases assume earlier ones
landed. After each phase, the user can pause and verify.

1. **M1** — host on `:3030`. Smallest patch, biggest impact on the
   specific incident pattern.
2. **M2** — pass `PORT` to the PTY env. Stops collisions even when two
   forges run concurrently.
3. **M3** — `writeForgeFiles` populate wait. Closes the per-forge DB
   blast radius.
4. **M4** — settings.local.json + hook script. Deterministic block on
   the residual dangerous commands.
5. **M5** — `CLAUDE.md`. Shapes intent; small file, low risk.

## Out-of-spec follow-ups (worth tracking)

- Repair existing stale forges (their GitHub repos still have the
  template placeholder `.env.example` from before M3 landed). One-off
  script `pnpm forge:repair` would re-`writeForgeFiles` each.
- Auto-heal in `ensureClone`: if `.env.local` contains the placeholder
  `forge_template`, overwrite it with the per-forge value. Belt-and-
  suspenders for M3.
- Investigation: who deleted the `Showcase Gallery` forge row in the
  2026-05-13 incident (causing cascade delete of 103 messages from
  conversation `81efa101`). Separate bug; not addressed by M1–M5.
- Dashboard UX: a forge card in `crashed` state shows no restart action.
  The user has to navigate to the forge page (or refresh) to recover.
  Should expose a Restart / Start action directly on the card when
  status is `crashed` or `setup-failed`.

## Testing strategy

- **Unit:** TDD per mitigation, smallest reproducer first. The watcher
  fix that just landed (`fix(runtime): keep transcript watcher polling
  until WS closes`) is the template — write the failing test, apply the
  minimal change, watch it pass.
- **Integration:** existing `lib/services/forges.test.ts` and
  `lib/github/octokit-client.test.ts` cover the persistence paths.
- **E2E:** the Playwright suite at `tests/e2e/forge-*.spec.ts` exercises
  the start → connect → message-round-trip flow. Run after M1, M2, and
  M3 to catch port + WS regressions.
- **Manual smoke after each phase:** start a forge, send a message,
  verify the change behaves as expected. The incident pattern (the
  in-forge agent's `kill -9` ask) is the canary — after M1 it should
  stop happening because the forge agent never sees us as an obstacle.
