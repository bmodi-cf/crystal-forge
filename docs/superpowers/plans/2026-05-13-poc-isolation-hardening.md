# POC Isolation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the blast radius of an in-forge PTY agent so it can't kill the framework or wipe its database. Implements all five mitigations in the design spec at `docs/superpowers/specs/2026-05-13-poc-isolation-hardening-design.md`.

**Architecture:** Each mitigation is independently shippable. Phase order: M1 (host on :3030) → M2 (PORT env to PTY) → M3 (writeForgeFiles populate-wait) → M4 (PreToolUse hook injection) → M5 (per-forge CLAUDE.md). After each phase, run the relevant tests and commit.

**Tech Stack:** Next.js, TypeScript, Node 22 via fnm, Vitest, Playwright, Prisma, Octokit, node-pty, Bash.

---

## Phase M1 — Move host framework to :3030

### Task M1.1: Bump `DEV_PORT` and export `PORT` in `forge-launch.sh`

**Files:**
- Modify: `forge-launch.sh:27` and the line that runs `pnpm dev` at the end of the script.

- [ ] **Step 1: Change `DEV_PORT`**

```bash
# forge-launch.sh:27 — old
DEV_PORT=3000
# new
DEV_PORT=3030
```

- [ ] **Step 2: Export `PORT` so Next picks it up**

Find the final `exec pnpm dev` line near the bottom of the script (it follows the `Press Ctrl+C to stop the dev server.` banner). Prepend a `PORT` export so Next's dev server binds the chosen port:

```bash
# new line, just before `exec pnpm dev`:
export PORT="${DEV_PORT}"
exec pnpm dev
```

- [ ] **Step 3: Verify the launcher fails clean on a hand-test**

Run: `lsof -nP -iTCP:3030 -sTCP:LISTEN | tail -n +2`
Expected: empty (nothing on 3030).

Run: `./forge-launch.sh` (background), wait for `Ready in`, then `curl -sI http://localhost:3030 | head -1`
Expected: `HTTP/1.1 307 Temporary Redirect` (or 200) from the Next app.

Stop the launcher (TaskStop the background task) and confirm :3000 stays empty during the run:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN | tail -n +2
```

Expected: empty.

### Task M1.2: Sweep the repo for hardcoded `localhost:3000` host references

**Files (to discover):** any file under `app/`, `lib/`, `tests/`, `scripts/`, `*.md`, `*.json` that hardcodes `localhost:3000` and refers to *the host framework* (not a forge clone or the playwright `:80`).

- [ ] **Step 1: Enumerate candidates**

Run:

```bash
grep -RIn 'localhost:3000\|:3000' \
  --include='*.ts' --include='*.tsx' --include='*.sh' \
  --include='*.json' --include='*.mjs' --include='*.md' \
  /Users/bmodi/work/crystal-forge \
  | grep -v node_modules | grep -v '/.next/'
```

Expected baseline: `.claude/settings.local.json` permission lines, plus the launcher (already changed), plus the skill file (M1.3). If any other hit refers to the *host* (not a forge clone), include it in this task.

- [ ] **Step 2: Classify each hit**

For each match: is it about *the host framework* (rewrite to 3030) or *a forge clone's own dev server* (leave alone)? If unsure, leave alone — the host's hits are scarce and easy to spot (banner URLs, README quick-start, etc.).

- [ ] **Step 3: Apply rewrites**

For each host hit, change `localhost:3000` → `localhost:3030`. No code is shown here because the exact set of hits depends on Step 1.

### Task M1.3: Update the `forge-launch` skill instructions

**Files:**
- Modify: `.claude/skills/forge-launch/SKILL.md`

- [ ] **Step 1: Update port references**

Replace every `:3000` and `localhost:3000` (referring to the framework) with `:3030` and `localhost:3030`. Update the example commands:

```markdown
# old
- **Dev server on :3000**: `lsof -nP -iTCP:3000 -sTCP:LISTEN | tail -n +2`
# new
- **Dev server on :3030**: `lsof -nP -iTCP:3030 -sTCP:LISTEN | tail -n +2`
```

…and the ready-banner URL:

```
║   →  http://localhost:3030               ║
```

…and the port-collision error fix table entry:

```
| `Port 3030 is already in use by PID X` | Should have been caught in Phase 1 — re-do the detection. |
```

### Task M1.4: Commit M1

- [ ] **Step 1: Stage and commit**

```bash
git add forge-launch.sh .claude/skills/forge-launch/SKILL.md
# plus any other files touched by Task M1.2
git commit -m "$(cat <<'EOF'
fix(launcher): run host dev server on :3030 to avoid forge collision

Forges default to :3000 for their own dev servers, and the in-forge
agent's natural response to "port in use" is "kill what's on it" —
historically that was us. Moving the host off :3000 removes the
collision entirely.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase M2 — Pass `PORT=<forge_port>` into the PTY's env

### Task M2.1: Add a port-lookup helper to the runtime service

**Files:**
- Modify: `lib/services/runtime.ts` (add an internal getter that reads state.json without ACL).

- [ ] **Step 1: Write the failing test**

Add to an existing or new test file `lib/services/runtime.test.ts` (find the existing one if present):

```ts
// inside the existing describe('runtime service', ...) block, or a new describe
it('returns the forge port from state.json regardless of viewer', async () => {
  // Arrange: write a state file with one running forge.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-rt-'));
  process.env.CRYSTAL_FORGE_HOME = home;
  resetRuntimeService();
  await fs.writeFile(path.join(home, 'state.json'), JSON.stringify({
    'forge-xyz': {
      forgeId: 'forge-xyz', slug: 'demo', status: 'running',
      pid: 1234, port: 3002, startedAt: new Date().toISOString(),
      logPath: '/tmp/demo.log',
    },
  }));
  expect(await loadRuntimePort('forge-xyz')).toBe(3002);
  expect(await loadRuntimePort('forge-missing')).toBeNull();
});
```

Run: `pnpm vitest run lib/services/runtime.test.ts`
Expected: FAIL — `loadRuntimePort` is not exported.

- [ ] **Step 2: Add the helper**

Find the module-private `loadState()` in `lib/services/runtime.ts` (used by `makeRuntimeService`). Promote it to an exported function and add the port-lookup wrapper:

```ts
// lib/services/runtime.ts — near the existing loadState() definition

export async function loadRuntimeStateFile(): Promise<RuntimeStateFile> {
  // ← body of the existing module-private loadState() goes here unchanged.
  // Replace the original loadState() with: const loadState = loadRuntimeStateFile;
  // (or change every internal caller to use loadRuntimeStateFile directly).
}

/** No-ACL port lookup for trusted internal callers (e.g. the WS server). */
export async function loadRuntimePort(forgeId: string): Promise<number | null> {
  const state = await loadRuntimeStateFile();
  return state[forgeId]?.port ?? null;
}
```

Run: `pnpm vitest run lib/services/runtime.test.ts`
Expected: PASS.

### Task M2.2: Pass `PORT` through `WsServerOpts` to the PTY

**Files:**
- Modify: `lib/runtime/ws-server.ts`
- Test: `lib/runtime/ws-server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the existing ws-server test file:

```ts
it('passes PORT=<forge_port> in the PTY env', async () => {
  const captured: SpawnOpts[] = [];
  const spawnPty = (opts: SpawnOpts): Session => {
    captured.push(opts);
    return makeFakeSession();
  };
  const loadConversation = async () => ({
    id: 'conv-1', forgeId: 'forge-xyz', slug: 'demo', claudeSessionId: null,
  });
  const loadForgePort = async (forgeId: string) =>
    forgeId === 'forge-xyz' ? 3002 : null;

  const server = await startWsServer({
    port: 0, secret: 'shh',
    spawnPty, loadConversation, loadForgePort,
    startWatcher: () => ({ stop: () => {} }),
    appendMessage: async () => {},
    setClaudeSessionId: async () => {},
  });
  // ...connect a WebSocket with a valid ticket (use existing helper or signTicket)
  // After connection, assert:
  expect(captured[0]?.env).toMatchObject({ PORT: '3002' });

  server.stop();
});
```

Run: `pnpm vitest run lib/runtime/ws-server.test.ts`
Expected: FAIL — `loadForgePort` is not a supported option, env is not set.

- [ ] **Step 2: Extend `WsServerOpts` and use it**

In `lib/runtime/ws-server.ts`:

```ts
export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (cid: string, dir: string, deps: WatcherDeps) => { stop: () => void };
  forgeClonePath?: (slug: string) => string;
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
  loadForgePort?: (forgeId: string) => Promise<number | null>;       // ← NEW
  appendMessage?: (...) => Promise<void>;
  setClaudeSessionId?: (...) => Promise<void>;
};

export function startWsServer(opts: WsServerOpts) {
  // ...existing defaults
  const loadForgePort = opts.loadForgePort ?? defaultLoadForgePort;
  // import defaultLoadForgePort at the top: `import { loadRuntimePort as defaultLoadForgePort } from '@/lib/services/runtime';`
  // ...
  wss.on('connection', async (ws, req) => {
    // ...existing ticket + loadConversation logic
    const conv = await loadConversation(payload.conversationId);
    if (!conv) { ws.close(4404, 'Conversation not found'); return; }

    const port = await loadForgePort(conv.forgeId);
    const env: Record<string, string> = {};
    if (port !== null) env.PORT = String(port);

    const cwd = forgeClonePath(conv.slug);
    const pty = spawnPty({
      cwd, cols: 80, rows: 24,
      ...(conv.claudeSessionId ? { args: ['--resume', conv.claudeSessionId] } : {}),
      env,                                                            // ← NEW
    });
    // ...rest unchanged
  });
}
```

Note: `conv.forgeId` must exist on `ConversationLite`. If it doesn't, also extend `ConversationLite` and `loadConversationLite` to include it.

Run: `pnpm vitest run lib/runtime/ws-server.test.ts`
Expected: PASS.

### Task M2.3: Commit M2

- [ ] **Step 1: Stage and commit**

```bash
git add lib/services/runtime.ts lib/services/runtime.test.ts \
        lib/runtime/ws-server.ts lib/runtime/ws-server.test.ts
# add lib/services/conversations.ts if ConversationLite was extended
git commit -m "$(cat <<'EOF'
feat(runtime): inject PORT=<forge_port> into the PTY env

The forge runtime allocates a port per forge but never told the PTY
about it. The in-forge agent's `npm run dev` defaulted to :3000 and
collided with anything already there. PORT in the env lets Next pick
up the right port without the agent having to know about it.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase M3 — `writeForgeFiles` template-populate wait

### Task M3.1: Failing test for populate-wait

**Files:**
- Test: `lib/github/octokit-client.test.ts`

- [ ] **Step 1: Add the test**

Append a new test to the existing octokit-client suite:

```ts
it('waits for template populate before writing forge files', async () => {
  let getContentCalls = 0;
  const putCalls: PutArgs[] = [];

  const octokit = makeOctokitWith(
    async (args) => { putCalls.push(args); return {}; },
    async (args) => {
      // Simulate template-populate completing after the 3rd getContent call.
      getContentCalls++;
      if (args.path === 'package.json' && getContentCalls < 3) throw status(404);
      return { data: { type: 'file', sha: 'abc123' } };
    },
  );
  const client = newClient(octokit);

  const files: ForgeFiles = {
    forgeConfig: { name: 'X', description: null, slug: 'x', dbName: 'x_db', createdAt: 'now' },
    envExample: 'DATABASE_URL=postgres://x/x_db\n',
  };
  await client.writeForgeFiles('bmodi-cf/x', files);

  // Both forge files were written AFTER populate confirmed.
  expect(getContentCalls).toBeGreaterThanOrEqual(3);
  expect(putCalls.map((c) => c.path).sort()).toEqual(['.env.example', 'forge.config.json']);
});
```

Run: `pnpm vitest run lib/github/octokit-client.test.ts`
Expected: FAIL — current `writeForgeFiles` does not poll for populate.

### Task M3.2: Implement `waitForTemplatePopulate` and call it

**Files:**
- Modify: `lib/github/octokit-client.ts`

- [ ] **Step 1: Add the private helper and call it**

Just above `writeForgeFiles`, add:

```ts
/**
 * GitHub's createUsingTemplate is asynchronous — the new repo can return
 * 404 on contents reads/writes for a few hundred ms after the call returns,
 * and (worse) the template populate later overwrites any commits we make
 * before it completes. Poll a known template file until it's visible, then
 * any subsequent writeForgeFiles commits stick.
 */
private async waitForTemplatePopulate(owner: string, repo: string): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const { data } = await this.client.repos.getContent({
        owner, repo, path: 'package.json',
      });
      if (!Array.isArray(data) && (data as { type?: string }).type === 'file') return;
    } catch (err: unknown) {
      if (!isStatus(err, 404)) throw err;
    }
    if (attempt >= this.retryDelaysMs.length) {
      throw new Error(`Template populate for ${owner}/${repo} did not complete in time`);
    }
    await sleep(this.retryDelaysMs[attempt]!);
    attempt++;
  }
}
```

Then at the top of `writeForgeFiles`:

```ts
async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
  const [owner, repo] = parseFullName(fullName);
  await this.waitForTemplatePopulate(owner, repo);            // ← NEW
  // ...existing putContents calls unchanged
}
```

Run: `pnpm vitest run lib/github/octokit-client.test.ts`
Expected: PASS, including the new test.

### Task M3.3: Update the `writeForgeFiles` JSDoc in `types.ts`

**Files:**
- Modify: `lib/github/types.ts:55-65`

- [ ] **Step 1: Replace the docstring**

```ts
/**
 * Waits for GitHub's async template populate to complete (poll
 * `contents/package.json` until present), then commits forge.config.json
 * AND .env.example to the default branch of `fullName`. Without the wait,
 * GitHub's later populate commit overwrites our writes silently.
 *
 * Each commit uses an upsert PUT (fetch sha then re-PUT) so adopting an
 * already-populated repo also works.
 *
 * Throws on any failure; caller is responsible for compensation.
 */
writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void>;
```

### Task M3.4: Commit M3

- [ ] **Step 1: Stage and commit**

```bash
git add lib/github/octokit-client.ts lib/github/octokit-client.test.ts lib/github/types.ts
git commit -m "$(cat <<'EOF'
fix(github): wait for template populate before writing forge files

createUsingTemplate returns before GitHub finishes copying the template
files. Our forge.config.json / .env.example commits were landing on an
empty repo as root commits, then the template's later "Initial commit"
overwrote them — so the cloned forge ended up with the template's
placeholder DATABASE_URL. Poll contents/package.json with bounded
backoff to confirm populate before our writes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase M4 — Inject `.claude/settings.local.json` + PreToolUse hook

### Task M4.1: Extend the `ForgeFiles` type and add render helpers

**Files:**
- Modify: `lib/github/types.ts`
- Modify: `lib/services/forges.ts`

- [ ] **Step 1: Extend `ForgeFiles`**

```ts
// lib/github/types.ts
export type ForgeFiles = {
  forgeConfig: ForgeConfigPayload;
  envExample: string;
  /** `.claude/settings.local.json` body — PreToolUse hook config. */
  claudeSettings: string;
  /** `.claude/hooks/block-dangerous-commands.sh` body — invoked by the hook. */
  claudeBlockScript: string;
};
```

- [ ] **Step 2: Add the two render helpers**

```ts
// lib/services/forges.ts — near renderEnvExample

export function renderClaudeSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '.claude/hooks/block-dangerous-commands.sh' }],
      }],
    },
  }, null, 2) + '\n';
}

export function renderBlockScript(): string {
  return `#!/usr/bin/env bash
set -e
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")

# Block process kills — never legitimate inside a forge sandbox.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])(kill|pkill|killall)([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: kill/pkill/killall not allowed inside a forge sandbox.\\n' >&2
  exit 2
fi

# Block any reference to the host database.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_])crystal_forge([^A-Za-z0-9_]|$) ]]; then
  printf 'Blocked: cannot reference the host crystal_forge database.\\n' >&2
  exit 2
fi

exit 0
`;
}
```

### Task M4.2: Failing test — `writeForgeFiles` writes the two new files

**Files:**
- Modify: `lib/github/octokit-client.test.ts`
- Modify: `lib/github/fake-client.test.ts`

- [ ] **Step 1: Add octokit-side test**

Add to the existing octokit-client suite (after Task M3.1's test):

```ts
it('writes .claude/settings.local.json and the hook script', async () => {
  const putCalls: PutArgs[] = [];
  const octokit = makeOctokitWith(
    async (args) => { putCalls.push(args); return {}; },
    async () => ({ data: { type: 'file', sha: 'abc' } }), // populate is "done"
  );
  const client = newClient(octokit);

  const files: ForgeFiles = {
    forgeConfig: { name: 'X', description: null, slug: 'x', dbName: 'x_db', createdAt: 'now' },
    envExample: 'DATABASE_URL=...\n',
    claudeSettings: '{"hooks":{}}\n',
    claudeBlockScript: '#!/usr/bin/env bash\nexit 0\n',
  };
  await client.writeForgeFiles('bmodi-cf/x', files);

  const paths = putCalls.map((c) => c.path).sort();
  expect(paths).toEqual([
    '.claude/hooks/block-dangerous-commands.sh',
    '.claude/settings.local.json',
    '.env.example',
    'forge.config.json',
  ]);
});
```

- [ ] **Step 2: Add fake-client-side test**

In `lib/github/fake-client.test.ts`, find the existing test for `writeForgeFiles` (looks like "stores files for a known repo" or similar). Extend its `ForgeFiles` literal:

```ts
const files: ForgeFiles = {
  forgeConfig: { name: 'X', description: null, slug: 'x', dbName: 'x_db', createdAt: 'now' },
  envExample: 'DATABASE_URL=...\n',
  claudeSettings: '{"hooks":{}}\n',
  claudeBlockScript: '#!/usr/bin/env bash\nexit 0\n',
};
await fake.writeForgeFiles('o/r', files);
expect(fake.getFiles('o/r')).toEqual(files);
```

The `FakeGitHubClient.writeForgeFiles` already stores the whole `files` object, so the assertion change is the only edit needed here — no production change in `fake-client.ts` for this step.

Run: `pnpm vitest run lib/github/`
Expected: FAIL — `writeForgeFiles` doesn't yet PUT the new files; `ForgeFiles` may not yet have the new fields (compile error).

### Task M4.3: Implement the two new `putContents` calls

**Files:**
- Modify: `lib/github/octokit-client.ts:82-99`

- [ ] **Step 1: Add the calls**

```ts
async writeForgeFiles(fullName: string, files: ForgeFiles): Promise<void> {
  const [owner, repo] = parseFullName(fullName);
  await this.waitForTemplatePopulate(owner, repo);

  const forgeConfigBody = JSON.stringify(files.forgeConfig, null, 2) + '\n';
  await this.putContents(owner, repo, 'forge.config.json', forgeConfigBody, 'chore: write forge.config.json');
  await this.putContents(owner, repo, '.env.example',       files.envExample,       'chore: write .env.example');
  await this.putContents(owner, repo, '.claude/settings.local.json', files.claudeSettings,     'chore: write .claude/settings.local.json');
  await this.putContents(owner, repo, '.claude/hooks/block-dangerous-commands.sh', files.claudeBlockScript, 'chore: write .claude block hook');
}
```

Run: `pnpm vitest run lib/github/`
Expected: PASS.

### Task M4.4: Wire seed + forges.create to pass the new fields

**Files:**
- Modify: `prisma/seed.ts` (the `writeForgeFiles` call)
- Modify: `lib/services/forges.ts:148` (the `writeForgeFiles` call)

- [ ] **Step 1: Update both call sites**

In each spot where `writeForgeFiles` is called, change:

```ts
await client.writeForgeFiles(repoFullName, {
  forgeConfig: { ... },
  envExample: renderEnvExample(dbName),
  claudeSettings: renderClaudeSettings(),       // ← NEW
  claudeBlockScript: renderBlockScript(),       // ← NEW
});
```

Run: `pnpm tsc --noEmit && pnpm vitest run`
Expected: typecheck clean, all unit tests pass.

### Task M4.5: `chmod +x` the hook script during `ensureClone`

**Files:**
- Modify: `lib/runtime/clone.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/clone.test.ts`. The existing tests use a fake `CommandRunner` whose `git clone` callback materializes the clone dir contents. Reuse the same pattern:

```ts
it('chmods the block hook script executable after clone', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-clone-'));
  process.env.CRYSTAL_FORGE_HOME = home;
  const cloneDir = path.join(home, 'clones', 'demo');

  const runner: CommandRunner = {
    run: async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') {
        await fs.mkdir(path.join(cloneDir, '.claude', 'hooks'), { recursive: true });
        await fs.writeFile(
          path.join(cloneDir, '.claude', 'hooks', 'block-dangerous-commands.sh'),
          '#!/usr/bin/env bash\nexit 0\n',
          { mode: 0o644 },
        );
        await fs.mkdir(path.join(cloneDir, '.git'), { recursive: true });
      }
      return { exitCode: 0 };
    },
  };

  const fakeClient = {
    getInstallationToken: async () => 'token',
  } as unknown as GitHubClient;

  await ensureClone({ slug: 'demo', repoFullName: 'o/r' }, fakeClient, runner);

  const stat = await fs.stat(path.join(cloneDir, '.claude', 'hooks', 'block-dangerous-commands.sh'));
  expect(stat.mode & 0o111).not.toBe(0);
});
```

Run: `pnpm vitest run lib/runtime/clone.test.ts`
Expected: FAIL — `ensureClone` does not yet chmod the hook script.

Run: `pnpm vitest run lib/runtime/clone.test.ts`
Expected: FAIL.

- [ ] **Step 2: Add the chmod after clone**

In `lib/runtime/clone.ts:ensureClone`, after `git clone` succeeds and the `git remote set-url` has run, before the `.env.local` copy:

```ts
const hookScript = path.join(cloneDir, '.claude', 'hooks', 'block-dangerous-commands.sh');
if (await exists(hookScript)) {
  await fs.chmod(hookScript, 0o755);
}
```

Run: `pnpm vitest run lib/runtime/clone.test.ts`
Expected: PASS.

### Task M4.6: Commit M4

- [ ] **Step 1: Stage and commit**

```bash
git add lib/github/types.ts lib/github/octokit-client.ts lib/github/octokit-client.test.ts \
        lib/github/fake-client.ts lib/github/fake-client.test.ts \
        lib/services/forges.ts prisma/seed.ts \
        lib/runtime/clone.ts lib/runtime/clone.test.ts
git commit -m "$(cat <<'EOF'
feat(forges): inject PreToolUse hook to block dangerous shell commands

Each forge clone now ships with .claude/settings.local.json registering
a PreToolUse hook on Bash that blocks kill/pkill/killall and any
reference to the host crystal_forge database. The hook script is
chmod +x'd after clone (GitHub's contents API doesn't preserve the
executable bit).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase M5 — Inject per-forge `CLAUDE.md`

### Task M5.1: Extend `ForgeFiles` + add `renderClaudeMd`

**Files:**
- Modify: `lib/github/types.ts`
- Modify: `lib/services/forges.ts`

- [ ] **Step 1: Add the field**

```ts
// lib/github/types.ts
export type ForgeFiles = {
  forgeConfig: ForgeConfigPayload;
  envExample: string;
  claudeSettings: string;
  claudeBlockScript: string;
  /** Top-level CLAUDE.md body — sandbox rules for the in-forge agent. */
  claudeMd: string;
};
```

- [ ] **Step 2: Add the render helper**

```ts
// lib/services/forges.ts

export function renderClaudeMd(name: string, dbName: string): string {
  return `# Forge: ${name}

You are working inside a Crystal Forge sandbox cloned to this directory.

## Sandbox rules

- Your dev server's port is provided by the \`PORT\` environment variable
  set by the host. Do not override it.
- Your database is **${dbName}**. Never touch \`crystal_forge\` or any
  database that isn't \`${dbName}\`.
- Do not run \`kill\`, \`pkill\`, \`killall\`, or any other process-killing
  command. If a port appears in use, start your server on a different
  port instead.
- Do not modify files outside this directory.

## Forge identity

See \`forge.config.json\` for \`name\`, \`description\`, \`slug\`, \`dbName\`,
\`createdAt\`.
`;
}
```

### Task M5.2: Failing test — `writeForgeFiles` writes CLAUDE.md

**Files:**
- Modify: `lib/github/octokit-client.test.ts`
- Modify: `lib/github/fake-client.test.ts`

- [ ] **Step 1: Extend the existing path-set assertion**

In the test added in Task M4.2, change the expected paths to include `CLAUDE.md`:

```ts
expect(paths).toEqual([
  '.claude/hooks/block-dangerous-commands.sh',
  '.claude/settings.local.json',
  '.env.example',
  'CLAUDE.md',
  'forge.config.json',
]);
```

Also extend the test's `ForgeFiles` literal with `claudeMd: '# Forge\n'`.

Run: `pnpm vitest run lib/github/`
Expected: FAIL.

### Task M5.3: Implement the new `putContents` call

**Files:**
- Modify: `lib/github/octokit-client.ts`

- [ ] **Step 1: Add the call**

```ts
await this.putContents(owner, repo, 'CLAUDE.md', files.claudeMd, 'chore: write CLAUDE.md');
```

Run: `pnpm vitest run lib/github/`
Expected: PASS.

### Task M5.4: Wire seed + forges.create to pass `claudeMd`

**Files:**
- Modify: `prisma/seed.ts`
- Modify: `lib/services/forges.ts`

- [ ] **Step 1: Update both call sites**

```ts
await client.writeForgeFiles(repoFullName, {
  forgeConfig: { ... },
  envExample: renderEnvExample(dbName),
  claudeSettings: renderClaudeSettings(),
  claudeBlockScript: renderBlockScript(),
  claudeMd: renderClaudeMd(name, dbName),    // ← NEW (seed has `name` as `f.name`; service has `input.name`)
});
```

Run: `pnpm tsc --noEmit && pnpm vitest run`
Expected: typecheck clean, all unit tests pass.

### Task M5.5: Commit M5

- [ ] **Step 1: Stage and commit**

```bash
git add lib/github/types.ts lib/github/octokit-client.ts lib/github/octokit-client.test.ts \
        lib/github/fake-client.ts lib/github/fake-client.test.ts \
        lib/services/forges.ts prisma/seed.ts
git commit -m "$(cat <<'EOF'
feat(forges): inject per-forge CLAUDE.md with sandbox rules

Tells the in-forge agent (in prose) which DB to touch, that the host
port is controlled by env, and that kill commands are off-limits.
Backstop for the hook in M4.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Manual smoke after all phases

- [ ] **Step 1: Relaunch host on the new port**

```bash
./forge-launch.sh
# (background)
# Wait for Ready in, then verify http://localhost:3030 loads.
```

- [ ] **Step 2: Delete one stale forge GitHub repo to force fresh-template path**

```bash
gh api -X DELETE repos/bmodi-cf/hello-world
```

- [ ] **Step 3: Create a fresh forge via the UI**

In the dashboard at http://localhost:3030, create a forge named `Hello World`. Start it. Confirm the clone at `~/.crystal-forge/clones/hello-world/.env.local` contains the correct per-forge dbname (not `forge_template`), and that `CLAUDE.md`, `.claude/settings.local.json`, and `.claude/hooks/block-dangerous-commands.sh` are all present in the clone.

- [ ] **Step 4: Verify the hook blocks `kill`**

Open the chat panel for Hello World, ask the agent to run `kill 1`. Expected: the harness reports the hook blocked the command before execution.

- [ ] **Step 5: Verify the host survives a port collision**

Have the agent run `npm run dev` without `--port`. Expected: the agent's Next picks up `PORT=<forge_port>` from the env and binds there; no collision with the host on :3030.
