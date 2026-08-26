# Forge File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drag files onto the Claude Code chat panel at `/forges/[id]` and have them land in the running forge's checkout at `/workspace/uploads/`, with the resolved path typed into Claude's prompt.

**Architecture:** A new narrow `ContainerManager.writeUpload()` streams the raw HTTP request body into `docker exec -i … sh -c 'cat > …'` inside the forge container. A service method on `RuntimeService` enforces ACL, the running-runtime precondition, filename sanitization, the byte cap, and per-forge serialization. The chat panel uploads one `XMLHttpRequest` per file for real progress, then writes each resolved path into the PTY.

**Tech Stack:** Next.js 16 App Router route handlers, TypeScript strict, `node:child_process` + `node:stream`, Vitest (colocated `*.test.ts(x)`), Playwright e2e, React 19, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-17-forge-file-upload-design.md`

## Global Constraints

- **Uploads are working-tree only.** No `git add`, no commit, no push, ever. If you find yourself writing a git command, you have left the scope of this plan.
- **Destination is `/workspace/uploads/<name>`**, collisions resolved with numeric suffixes: `logo.png` → `logo-2.png` → `logo-3.png`.
- **Byte cap: `100 * 1024 * 1024`** (100 MB) per file. Exposed as `UPLOAD_BYTE_LIMIT` from `lib/runtime/upload-name.ts` and imported everywhere it is needed — never re-typed as a literal.
- **Nothing buffers the whole file in the dashboard heap.** No `request.formData()`, no `await req.arrayBuffer()`, no `Buffer.concat` of the body in production code paths. The fake container manager may buffer (tests only).
- **The filename never enters a shell command string.** It travels to the container as the `UPLOAD_NAME` env var via `docker exec -e`.
- **Path injection carries a trailing space and no newline** — `session.send('uploads/logo.png ')`. Nothing auto-submits.
- **`containerId` never reaches the client.** `RuntimeStateView` omits it (`lib/runtime/types.ts:26`); keep it that way. The client posts a forge id and receives a path.
- **Edit-mode only.** The route starts with `devOnlyRouteGuard()`, like `app/api/forges/[id]/conversations/route.ts`.
- **No database changes.** No Prisma schema edit, no migration, no `pnpm db:migrate`.
- **TypeScript strict.** `pnpm typecheck` must pass at every commit. `exactOptionalPropertyTypes` is in play in this repo — build optional properties with the `...(x ? { k: x } : {})` spread idiom you see in `lib/runtime/container/docker-container-manager.ts`.
- **Tests are colocated** as `*.test.ts(x)` beside the source; Playwright lives in `tests/e2e/`.
- **Do not run `pnpm db:reset` or `./forge-launch.sh --seed`** — both destroy local data, and this working directory is the live pilot.
- Full unit suite: `pnpm test`. Single file without Postgres: `npx vitest run <file> --config vitest.unit.config.ts`.

---

### Task 1: `writeUpload` on the ContainerManager interface + fake

**Files:**
- Modify: `lib/runtime/container/types.ts`
- Modify: `lib/runtime/container/fake-container-manager.ts`
- Test: `lib/runtime/container/fake-container-manager.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `ContainerManager.writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }>` — returns the repo-relative path, e.g. `{ path: 'uploads/logo-2.png' }`.
  - `FakeContainerManager.uploads: { id: string; path: string; bytes: number }[]` — public array for assertions.

- [x] **Step 1: Write the failing test**

Append to `lib/runtime/container/fake-container-manager.test.ts`:

```ts
import { Readable } from 'node:stream';

describe('FakeContainerManager.writeUpload', () => {
  it('records the upload and returns the repo-relative path', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const res = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['abc']) });
    expect(res.path).toBe('uploads/logo.png');
    expect(mgr.uploads).toEqual([{ id, path: 'uploads/logo.png', bytes: 3 }]);
  });

  it('suffixes colliding names per container', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const a = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['a']) });
    const b = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['bb']) });
    const c = await mgr.writeUpload(id, { name: 'logo.png', body: Readable.from(['ccc']) });
    expect([a.path, b.path, c.path]).toEqual([
      'uploads/logo.png', 'uploads/logo-2.png', 'uploads/logo-3.png',
    ]);
  });

  it('suffixes extensionless names without a stray dot', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    await mgr.writeUpload(id, { name: 'NOTES', body: Readable.from(['x']) });
    const second = await mgr.writeUpload(id, { name: 'NOTES', body: Readable.from(['x']) });
    expect(second.path).toBe('uploads/NOTES-2');
  });

  it('propagates a body stream error instead of recording an upload', async () => {
    const mgr = new FakeContainerManager();
    const id = await mgr.create({ name: 'c', image: 'img' });
    const boom = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(mgr.writeUpload(id, { name: 'x.txt', body: boom })).rejects.toThrow('boom');
    expect(mgr.uploads).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/runtime/container/fake-container-manager.test.ts --config vitest.unit.config.ts`
Expected: FAIL — `mgr.writeUpload is not a function`.

- [x] **Step 3: Add the interface member**

In `lib/runtime/container/types.ts`, add the import and the method. Put the method after `exec` so the reading order matches the implementations:

```ts
import type { Readable } from 'node:stream';
```

```ts
export type ContainerManager = {
  /** Create + start a detached container; returns its id. */
  create(spec: CreateContainerSpec): Promise<string>;
  /** Run a one-off command inside a running container. */
  exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }>;
  /**
   * Stream `body` into <workdir>/uploads/ inside the container, resolving name
   * collisions with a numeric suffix. Returns the resolved repo-relative path.
   * Streaming (rather than exec) because uploads are up to 100 MB and must not
   * be buffered in the dashboard's heap.
   */
  writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }>;
  inspect(id: string): Promise<ContainerStatus>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** List containers, optionally filtered by a `key=value` label. */
  list(opts?: { label?: string }): Promise<ContainerSummary[]>;
};
```

- [x] **Step 4: Implement it on the fake**

In `lib/runtime/container/fake-container-manager.ts`, add the import, the `uploads` field, a shared collision helper, and the method:

```ts
import type { Readable } from 'node:stream';
```

```ts
export type UploadRecord = { id: string; path: string; bytes: number };

/**
 * Resolve `name` against names already taken in `taken`, appending -2, -3, …
 * before the extension. Mirrors the container-side shell loop in
 * docker-container-manager.ts so fake and real behave identically.
 */
export function resolveUploadName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let cand = name;
  let i = 2;
  while (taken.has(cand)) { cand = `${stem}-${i}${ext}`; i += 1; }
  return cand;
}
```

Inside the class:

```ts
  readonly uploads: UploadRecord[] = [];
  private readonly takenUploads = new Map<string, Set<string>>();

  async writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }> {
    // Drain first: a body that errors must reject before anything is recorded.
    let bytes = 0;
    for await (const chunk of opts.body) bytes += Buffer.from(chunk as Buffer).length;
    let taken = this.takenUploads.get(id);
    if (!taken) { taken = new Set<string>(); this.takenUploads.set(id, taken); }
    const resolved = resolveUploadName(opts.name, taken);
    taken.add(resolved);
    const path = `uploads/${resolved}`;
    this.uploads.push({ id, path, bytes });
    return { path };
  }
```

- [x] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/runtime/container/fake-container-manager.test.ts --config vitest.unit.config.ts`
Expected: PASS (4 new tests).

- [x] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0. It will FAIL if `DockerContainerManager` no longer satisfies `ContainerManager` — that is expected and Task 2 fixes it. If it fails **only** with `Property 'writeUpload' is missing in type 'DockerContainerManager'`, that is the correct state; proceed. Any other error is yours to fix now.

- [x] **Step 7: Commit**

```bash
git add lib/runtime/container/types.ts lib/runtime/container/fake-container-manager.ts lib/runtime/container/fake-container-manager.test.ts
git commit -m "feat(runtime): writeUpload on ContainerManager + fake implementation"
```

---

### Task 2: Docker implementation of `writeUpload`

**Files:**
- Modify: `lib/runtime/container/docker-container-manager.ts`
- Test: `lib/runtime/container/docker-container-manager.test.ts`

**Interfaces:**
- Consumes: `ContainerManager.writeUpload` signature from Task 1.
- Produces:
  - `SpawnStream` type: `(cmd: string, args: string[], stdin: Readable) => Promise<{ exitCode: number; stdout: string; stderr: string }>`
  - `DockerDeps.spawnStream?: SpawnStream` — the injectable seam, matching the existing `capture` / `runner` pattern.
  - `UPLOAD_SCRIPT` (exported const) — the POSIX `sh` script run in the container.

- [x] **Step 1: Write the failing test**

Append to `lib/runtime/container/docker-container-manager.test.ts`:

```ts
import { Readable } from 'node:stream';
import { UPLOAD_SCRIPT } from './docker-container-manager';

describe('DockerContainerManager.writeUpload', () => {
  function harness(result: { exitCode: number; stdout: string; stderr: string }) {
    const calls: { cmd: string; args: string[]; stdin: Readable }[] = [];
    const mgr = new DockerContainerManager({
      spawnStream: async (cmd, args, stdin) => { calls.push({ cmd, args, stdin }); return result; },
    });
    return { mgr, calls };
  }

  it('passes the filename as an env var, never in the script', async () => {
    const { mgr, calls } = harness({ exitCode: 0, stdout: 'uploads/a b.png\n', stderr: '' });
    const res = await mgr.writeUpload('c1', { name: 'a b.png', body: Readable.from(['x']) });

    expect(res).toEqual({ path: 'uploads/a b.png' });
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe('docker');
    expect(args).toEqual([
      'exec', '-i', '-w', '/workspace', '-e', 'UPLOAD_NAME=a b.png',
      'c1', 'sh', '-c', UPLOAD_SCRIPT,
    ]);
    // The script is a fixed constant — the untrusted name is nowhere inside it.
    expect(args[9]).not.toContain('a b.png');
  });

  it('is not fooled by a shell-metacharacter filename', async () => {
    const { mgr, calls } = harness({ exitCode: 0, stdout: 'uploads/x.txt\n', stderr: '' });
    const evil = '"; rm -rf / #';
    await mgr.writeUpload('c1', { name: evil, body: Readable.from(['x']) });
    expect(calls[0]!.args).toContain(`UPLOAD_NAME=${evil}`);
    expect(calls[0]!.args[9]).toBe(UPLOAD_SCRIPT);
  });

  it('returns the last stdout line as the path, tolerating trailing noise', async () => {
    const { mgr } = harness({ exitCode: 0, stdout: 'uploads/logo-2.png\n', stderr: '' });
    const res = await mgr.writeUpload('c1', { name: 'logo.png', body: Readable.from(['x']) });
    expect(res.path).toBe('uploads/logo-2.png');
  });

  it('throws with stderr when the exec exits non-zero', async () => {
    const { mgr } = harness({ exitCode: 1, stdout: '', stderr: 'No space left on device\n' });
    await expect(mgr.writeUpload('c1', { name: 'x.txt', body: Readable.from(['x']) }))
      .rejects.toThrow(/No space left on device/);
  });

  it('throws when the exec succeeds but prints no path', async () => {
    const { mgr } = harness({ exitCode: 0, stdout: '\n', stderr: '' });
    await expect(mgr.writeUpload('c1', { name: 'x.txt', body: Readable.from(['x']) }))
      .rejects.toThrow(/no path/i);
  });
});
```

If the existing test file constructs `DockerContainerManager` with a helper rather than inline deps, follow that file's local convention for building the instance — only the `spawnStream` dep is new.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/runtime/container/docker-container-manager.test.ts --config vitest.unit.config.ts`
Expected: FAIL — `UPLOAD_SCRIPT` is not exported / `writeUpload is not a function`.

- [x] **Step 3: Implement the script, the default spawn seam, and the method**

In `lib/runtime/container/docker-container-manager.ts`:

```ts
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { CONTAINER_WORKDIR } from '../paths';
```

```ts
/**
 * Container-side upload script. POSIX sh, run via `sh -c`.
 *
 * The filename arrives as $UPLOAD_NAME (a docker `-e` env var) and is never
 * interpolated into this string, so no filename can inject shell syntax.
 *
 * Writes to a dotted .part file and mv's into place only on a clean cat, with a
 * trap sweeping the fragment on any failure — so a dropped connection or a full
 * volume never leaves a truncated file under the real name.
 */
export const UPLOAD_SCRIPT = [
  'set -e',
  'mkdir -p uploads',
  'n="$UPLOAD_NAME"',
  'case "$n" in *.*) stem="${n%.*}"; ext=".${n##*.}" ;; *) stem="$n"; ext="" ;; esac',
  'cand="$n"; i=2',
  'while [ -e "uploads/$cand" ]; do cand="$stem-$i$ext"; i=$((i+1)); done',
  'tmp="uploads/.$cand.part"',
  `trap 'rm -f "$tmp"' EXIT`,
  'cat > "$tmp"',
  'mv "$tmp" "uploads/$cand"',
  `printf '%s\\n' "uploads/$cand"`,
].join('\n');

export type SpawnStream = (
  cmd: string,
  args: string[],
  stdin: Readable,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Spawn a command with a piped stdin and captured output. Separate from
 * childProcessRunner, which hard-codes stdio:['ignore', fd, fd] and so can
 * neither accept a body nor return the resolved path.
 */
function defaultSpawnStream(cmd: string, args: string[], stdin: Readable) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    // The child exiting early makes our writes EPIPE; swallow so it surfaces as
    // a non-zero exit with stderr rather than an unhandled 'error' event.
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('exit', (code) => resolve({ exitCode: code ?? -1, stdout: out, stderr: err }));
    // A body error (byte-cap overrun, client abort) must surface to the caller
    // as *that* error, not as a generic docker failure.
    stdin.once('error', (bodyErr: Error) => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(bodyErr);
    });
    stdin.pipe(child.stdin);
  });
}
```

Add to `DockerDeps`:

```ts
export type DockerDeps = {
  /** Injectable for tests; runs `docker <args>` and returns stdout. */
  capture?: (cmd: string, args: string[]) => Promise<string>;
  /** Injectable for tests; runs a logged, fire-and-forget docker command. */
  runner?: CommandRunner;
  /** Injectable for tests; runs a command with piped stdin and captured output. */
  spawnStream?: SpawnStream;
};
```

In the class, add the field, assign it in the constructor beside the others, and add the method after `exec`:

```ts
  private readonly spawnStream: SpawnStream;
```

```ts
    this.spawnStream = deps.spawnStream ?? defaultSpawnStream;
```

```ts
  async writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }> {
    const args = [
      'exec', '-i',
      '-w', CONTAINER_WORKDIR,
      '-e', `UPLOAD_NAME=${opts.name}`,
      id, 'sh', '-c', UPLOAD_SCRIPT,
    ];
    const { exitCode, stdout, stderr } = await this.spawnStream('docker', args, opts.body);
    if (exitCode !== 0) {
      throw new Error(`upload failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const path = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!path) throw new Error('upload produced no path');
    return { path };
  }
```

No `-u` flag: the forge image ends with `USER forge` (`docker/forge-runtime.Dockerfile:35`), so the exec already runs as the user Claude runs as, and the file is owned by `forge`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/runtime/container/docker-container-manager.test.ts --config vitest.unit.config.ts`
Expected: PASS (5 new tests, existing ones unaffected).

- [x] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0. `DockerContainerManager` now satisfies the interface, so Task 1's expected typecheck failure is gone.

- [x] **Step 6: Commit**

```bash
git add lib/runtime/container/docker-container-manager.ts lib/runtime/container/docker-container-manager.test.ts
git commit -m "feat(runtime): stream uploads into the container via docker exec"
```

---

### Task 3: Filename sanitization + the byte-cap constant

**Files:**
- Create: `lib/runtime/upload-name.ts`
- Test: `lib/runtime/upload-name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sanitizeUploadName(raw: string): string`
  - `UPLOAD_BYTE_LIMIT: number` (= `100 * 1024 * 1024`)

- [x] **Step 1: Write the failing test**

Create `lib/runtime/upload-name.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeUploadName, UPLOAD_BYTE_LIMIT } from './upload-name';

describe('sanitizeUploadName', () => {
  it('keeps an ordinary filename intact', () => {
    expect(sanitizeUploadName('Site Survey v2.pdf')).toBe('Site Survey v2.pdf');
  });

  it('reduces a path to its basename', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadName('/absolute/logo.png')).toBe('logo.png');
    expect(sanitizeUploadName('C:\\Users\\bmodi\\notes.txt')).toBe('notes.txt');
  });

  it('strips control characters and newlines', () => {
    expect(sanitizeUploadName('bad\nname\u0000.txt')).toBe('badname.txt');
  });

  it('strips leading dots so uploads are never hidden files', () => {
    expect(sanitizeUploadName('.env')).toBe('env');
    expect(sanitizeUploadName('...gitconfig')).toBe('gitconfig');
  });

  it('falls back to "upload" when nothing usable remains', () => {
    expect(sanitizeUploadName('')).toBe('upload');
    expect(sanitizeUploadName('.')).toBe('upload');
    expect(sanitizeUploadName('..')).toBe('upload');
    expect(sanitizeUploadName('   ')).toBe('upload');
    expect(sanitizeUploadName('\u0000\u0001')).toBe('upload');
  });

  it('caps length at 255 characters, preserving the extension', () => {
    const out = sanitizeUploadName(`${'a'.repeat(300)}.png`);
    expect(out).toHaveLength(255);
    expect(out.endsWith('.png')).toBe(true);
  });

  it('caps length when there is no usable extension', () => {
    expect(sanitizeUploadName('b'.repeat(300))).toHaveLength(255);
  });

  it('exposes a 100 MB byte limit', () => {
    expect(UPLOAD_BYTE_LIMIT).toBe(104_857_600);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/runtime/upload-name.test.ts --config vitest.unit.config.ts`
Expected: FAIL — cannot resolve `./upload-name`.

- [x] **Step 3: Implement**

Create `lib/runtime/upload-name.ts`:

```ts
/** Per-file upload cap: 100 MB. */
export const UPLOAD_BYTE_LIMIT = 100 * 1024 * 1024;

const MAX_NAME_LEN = 255;

/** Truncate to `max` characters while keeping a short trailing extension. */
function truncateKeepingExt(name: string, max: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.slice(0, max);
  const ext = name.slice(dot);
  if (ext.length >= max) return name.slice(0, max);
  return name.slice(0, max - ext.length) + ext;
}

/**
 * Reduce a client-supplied filename to a safe basename for /workspace/uploads/.
 *
 * This is about producing *sane* filenames, not about escaping: the name reaches
 * the container as an env var, never inside a shell command string. Leading dots
 * are stripped so an upload is never a hidden file, which also keeps the
 * container-side collision loop from producing names like `-2.env`.
 */
export function sanitizeUploadName(raw: string): string {
  // Split on both separators so a Windows client cannot smuggle a path through.
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload';
  return cleaned.length > MAX_NAME_LEN ? truncateKeepingExt(cleaned, MAX_NAME_LEN) : cleaned;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/runtime/upload-name.test.ts --config vitest.unit.config.ts`
Expected: PASS (8 tests).

- [x] **Step 5: Lint (the control-character regex needs its disable comment to be accepted)**

Run: `pnpm lint`
Expected: exit 0, no warnings about the regex.

- [x] **Step 6: Commit**

```bash
git add lib/runtime/upload-name.ts lib/runtime/upload-name.test.ts
git commit -m "feat(runtime): sanitize upload filenames and define the byte cap"
```

---

### Task 4: `PayloadTooLargeError` → 413

**Files:**
- Modify: `lib/errors.ts`
- Modify: `lib/http.ts`
- Test: `lib/http.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `PayloadTooLargeError` (code `'PAYLOAD_TOO_LARGE'`), mapped to HTTP 413 by `respondToServiceError`.

- [ ] **Step 1: Write the failing test**

Add to `lib/http.test.ts` (create the file with this content if it does not exist):

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { respondToServiceError } from './http';
import { PayloadTooLargeError } from './errors';

describe('respondToServiceError', () => {
  it('maps PayloadTooLargeError to 413 with its message', async () => {
    const res = respondToServiceError(new PayloadTooLargeError('File exceeds the 100 MB limit'));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'File exceeds the 100 MB limit' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/http.test.ts --config vitest.unit.config.ts`
Expected: FAIL — `PayloadTooLargeError` is not exported (or the status is 500).

- [ ] **Step 3: Implement**

In `lib/errors.ts`, extend the union and add the class:

```ts
export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'RUNTIME_BUSY'
  | 'RUNTIME_CAPACITY'
  | 'PAYLOAD_TOO_LARGE';
```

```ts
export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super('PAYLOAD_TOO_LARGE', message);
  }
}
```

In `lib/http.ts`, add it to the import list and add the branch before the final `console.error` fallback:

```ts
  if (err instanceof PayloadTooLargeError) {
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/http.test.ts --config vitest.unit.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/errors.ts lib/http.ts lib/http.test.ts
git commit -m "feat(errors): PayloadTooLargeError mapped to 413"
```

---

### Task 5: `uploadToWorkspace` on the runtime service

**Files:**
- Modify: `lib/services/runtime.ts`
- Test: `lib/services/runtime.test.ts`

**Interfaces:**
- Consumes: `ContainerManager.writeUpload` (Task 1), `sanitizeUploadName` + `UPLOAD_BYTE_LIMIT` (Task 3), `PayloadTooLargeError` (Task 4).
- Produces, on the `RuntimeService` type:
  ```ts
  uploadToWorkspace(
    currentUser: SessionUser,
    forgeId: string,
    rawName: string,
    body: Readable,
    byteLimit?: number,
  ): Promise<{ path: string }>;
  ```
  Throws `ForbiddenError` (403), `NotFoundError` (404), `RuntimeBusyError` (409) when the runtime is not `running`, `PayloadTooLargeError` (413) on overrun.

- [ ] **Step 1: Write the failing test**

Add to `lib/services/runtime.test.ts`. Note the exact helper shapes this file uses (`lib/test/db.ts`): `withCleanDb` **passes `prisma` into the callback**, `makeUser(prisma, {...})` and `makeForge(prisma, {...})` take it as their first argument, and deps are spread as `makeRuntimeService({ ...fakes, prisma })`. The forge's creator passes `canWriteForge`, so no admin role is needed — a second user serves as the stranger, exactly as the existing `tom` / `intruder` tests do.

```ts
describe('uploadToWorkspace', () => {
  it('streams a file into the running container and returns its path', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');

      const res = await svc.uploadToWorkspace(tom, forge.id, 'logo.png', Readable.from(['abcd']));

      expect(res.path).toBe('uploads/logo.png');
      expect(fakes._containers.uploads).toHaveLength(1);
      expect(fakes._containers.uploads[0]!.bytes).toBe(4);
    });
  });

  it('sanitizes the name before it reaches the container', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');

      const res = await svc.uploadToWorkspace(tom, forge.id, '../../etc/passwd', Readable.from(['x']));
      expect(res.path).toBe('uploads/passwd');
    });
  });

  it('serializes same-name uploads onto distinct paths', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');

      const [a, b] = await Promise.all([
        svc.uploadToWorkspace(tom, forge.id, 'a.txt', Readable.from(['1'])),
        svc.uploadToWorkspace(tom, forge.id, 'a.txt', Readable.from(['22'])),
      ]);
      expect([a.path, b.path].sort()).toEqual(['uploads/a-2.txt', 'uploads/a.txt']);
    });
  });

  it('rejects a non-owner with ForbiddenError', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const intruder = await makeUser(prisma, { email: 'i@x', name: 'Ivan' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');

      await expect(svc.uploadToWorkspace(intruder, forge.id, 'x.txt', Readable.from(['x'])))
        .rejects.toBeInstanceOf(ForbiddenError);
      expect(fakes._containers.uploads).toHaveLength(0);
    });
  });

  it('rejects when the forge is not running', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const svc = makeRuntimeService({ ...makeFakes(), prisma });

      await expect(svc.uploadToWorkspace(tom, forge.id, 'x.txt', Readable.from(['x'])))
        .rejects.toBeInstanceOf(RuntimeBusyError);
    });
  });

  it('rejects a body that exceeds the byte limit', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom' });
      const forge = await makeForge(prisma, { name: 'Aquaflow Designer', createdById: tom.id });
      const fakes = makeFakes();
      const svc = makeRuntimeService({ ...fakes, prisma });
      await svc.startForge(tom, forge.id);
      await waitForRuntime(svc, tom, forge.id, (r) => r?.status === 'running');

      const body = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);
      await expect(svc.uploadToWorkspace(tom, forge.id, 'big.bin', body, 100))
        .rejects.toBeInstanceOf(PayloadTooLargeError);
    });
  });
});
```

Add the imports this block needs at the top of the file: `Readable` from `node:stream`, and `RuntimeBusyError` + `PayloadTooLargeError` alongside the existing `ForbiddenError` import from `@/lib/errors`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: FAIL — `svc.uploadToWorkspace is not a function`. (This suite needs Postgres; `./forge-launch.sh` without `--seed` is enough if the DB is not up.)

- [ ] **Step 3: Implement**

In `lib/services/runtime.ts`, add imports:

```ts
import { Readable, Transform } from 'node:stream';
import { ForbiddenError, NotFoundError, RuntimeBusyError, PayloadTooLargeError } from '@/lib/errors';
import { sanitizeUploadName, UPLOAD_BYTE_LIMIT } from '@/lib/runtime/upload-name';
```

Add to the `RuntimeService` type:

```ts
  uploadToWorkspace(
    currentUser: SessionUser,
    forgeId: string,
    rawName: string,
    body: Readable,
    byteLimit?: number,
  ): Promise<{ path: string }>;
```

Above `makeRuntimeService`, add the counting stream:

```ts
/**
 * Pass `source` through while counting bytes, failing the stream once `limit` is
 * exceeded. This is the authoritative server-side cap: the route's
 * Content-Length check is only a cheap pre-filter, and the client's is UX.
 */
function limitBytes(source: Readable, limit: number): Readable {
  let total = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      total += (chunk as Buffer).length;
      if (total > limit) {
        cb(new PayloadTooLargeError(`Upload exceeds the ${Math.floor(limit / (1024 * 1024))} MB limit`));
        return;
      }
      cb(null, chunk);
    },
  });
  source.on('error', (err) => counter.destroy(err));
  source.pipe(counter);
  return counter;
}
```

Inside `makeRuntimeService`, beside `startInflight` / `stopInflight`:

```ts
  // Uploads are serialized per forge so two files can't resolve the same
  // collision candidate. One dashboard process, so an in-memory chain suffices.
  const uploadChain = new Map<string, Promise<unknown>>();
```

Add the implementation in the returned object, after `stopForge`:

```ts
    async uploadToWorkspace(currentUser, forgeId, rawName, body, byteLimit = UPLOAD_BYTE_LIMIT) {
      const row = await loadForgeForAcl(forgeId);
      if (!canWriteForge(currentUser, aclFor(row))) {
        throw new ForbiddenError(`Cannot upload to forge ${forgeId}`);
      }
      const state = await loadState();
      const entry = state[forgeId];
      if (!entry || entry.status !== 'running' || !entry.containerId) {
        throw new RuntimeBusyError('Forge is not running; start the forge first');
      }
      const containerId = entry.containerId;
      const name = sanitizeUploadName(rawName);
      const counted = limitBytes(body, byteLimit);

      const prev = uploadChain.get(forgeId) ?? Promise.resolve();
      const run = prev
        .catch(() => {}) // a previous upload's failure must not poison this one
        .then(() => deps.containerManager.writeUpload(containerId, { name, body: counted }));
      uploadChain.set(forgeId, run.catch(() => {}));
      return run;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test lib/services/runtime.test.ts`
Expected: PASS, including the 6 new cases and every pre-existing test in the file.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/services/runtime.ts lib/services/runtime.test.ts
git commit -m "feat(runtime): uploadToWorkspace service with ACL, byte cap, serialization"
```

---

### Task 6: `POST /api/forges/[id]/uploads`

**Files:**
- Create: `app/api/forges/[id]/uploads/route.ts`
- Test: `app/api/forges/[id]/uploads/route.test.ts`

**Interfaces:**
- Consumes: `getRuntimeService().uploadToWorkspace(...)` (Task 5), `UPLOAD_BYTE_LIMIT` (Task 3), `devOnlyRouteGuard` (`lib/mode.ts`), `respondToServiceError` (`lib/http.ts`).
- Produces: `POST /api/forges/[id]/uploads?name=<filename>` — raw body in, `200 { path: string }` out.

- [ ] **Step 1: Write the failing test**

Create `app/api/forges/[id]/uploads/route.test.ts`, modelled on `app/api/forges/[id]/start/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const prev = process.env.FORGE_DASHBOARD_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_DASHBOARD_MODE;
  else process.env.FORGE_DASHBOARD_MODE = prev;
  vi.clearAllMocks();
});

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, { method: 'POST', ...init }) as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'f1' }) } as unknown as RouteContext<'/api/forges/[id]/uploads'>;

describe('uploads route', () => {
  it('returns 404 in prod mode before doing any work', async () => {
    process.env.FORGE_DASHBOARD_MODE = 'prod';
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads?name=a.txt'), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads?name=a.txt'), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'u1' } });
    const { POST } = await import('./route');
    const res = await POST(req('http://localhost/api/forges/f1/uploads', { body: 'x' }), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 413 when Content-Length exceeds the cap, without touching the service', async () => {
    delete process.env.FORGE_DASHBOARD_MODE;
    const { auth } = await import('@/lib/auth');
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'u1' } });
    const { POST } = await import('./route');
    const res = await POST(
      req('http://localhost/api/forges/f1/uploads?name=big.bin', {
        body: 'x',
        headers: { 'content-length': String(200 * 1024 * 1024) },
      }),
      ctx,
    );
    expect(res.status).toBe(413);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/api/forges/[id]/uploads/route.test.ts" --config vitest.unit.config.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement**

Create `app/api/forges/[id]/uploads/route.ts`:

```ts
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';
import { UPLOAD_BYTE_LIMIT } from '@/lib/runtime/upload-name';
import { getRuntimeService } from '@/lib/services/runtime';

/**
 * Stream a file into the forge's checkout at /workspace/uploads/.
 *
 * The body is raw bytes with the filename in ?name= — deliberately not
 * multipart, because request.formData() would buffer the whole file (cap:
 * 100 MB) in the dashboard's heap. One file per request; the client fires
 * several in parallel for a multi-file drop.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/uploads'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;

  const name = new URL(req.url).searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'Missing name parameter' }, { status: 400 });

  // Cheap pre-check so an honestly-declared oversize upload is refused before
  // any container work. The service is the authoritative enforcer.
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > UPLOAD_BYTE_LIMIT) {
    return NextResponse.json({ error: 'File exceeds the 100 MB limit' }, { status: 413 });
  }
  if (!req.body) return NextResponse.json({ error: 'Missing body' }, { status: 400 });

  const body = Readable.fromWeb(req.body as unknown as NodeWebReadableStream);
  // A cancelled upload kills the docker exec, whose trap sweeps the .part file.
  req.signal.addEventListener('abort', () => body.destroy(new Error('client aborted upload')));

  try {
    const { path } = await getRuntimeService().uploadToWorkspace(session.user, id, name, body);
    return NextResponse.json({ path });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/api/forges/[id]/uploads/route.test.ts" --config vitest.unit.config.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add "app/api/forges/[id]/uploads"
git commit -m "feat(api): POST /api/forges/[id]/uploads streams a file into the workspace"
```

---

### Task 7: `useUploads` hook

**Files:**
- Create: `app/(app)/forges/[id]/useUploads.ts`
- Test: `app/(app)/forges/[id]/useUploads.test.ts`

**Interfaces:**
- Consumes: the route from Task 6, `UPLOAD_BYTE_LIMIT` from Task 3.
- Produces:
  ```ts
  export type UploadItem = {
    key: number;
    name: string;
    percent: number;
    status: 'uploading' | 'done' | 'error';
    path?: string;
    error?: string;
  };
  export type UploadsApi = {
    items: UploadItem[];
    start: (files: File[]) => void;
    cancel: (key: number) => void;
    dismiss: (key: number) => void;
  };
  export function useUploads(
    forgeId: string,
    onUploaded: (path: string) => void,
  ): UploadsApi;
  ```

- [ ] **Step 1: Write the failing test**

Create `app/(app)/forges/[id]/useUploads.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUploads } from './useUploads';

type FakeXhr = {
  method?: string; url?: string; sent?: unknown;
  status: number; responseText: string;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open: (m: string, u: string) => void;
  setRequestHeader: (k: string, v: string) => void;
  send: (b: unknown) => void;
  abort: () => void;
};

let xhrs: FakeXhr[] = [];

beforeEach(() => {
  xhrs = [];
  vi.stubGlobal('XMLHttpRequest', function (this: FakeXhr) {
    const self = this;
    self.status = 0;
    self.responseText = '';
    self.upload = { onprogress: null };
    self.onload = null; self.onerror = null; self.onabort = null;
    self.open = (m, u) => { self.method = m; self.url = u; };
    self.setRequestHeader = () => {};
    self.send = (b) => { self.sent = b; };
    self.abort = () => { self.onabort?.(); };
    xhrs.push(self);
  } as unknown as typeof XMLHttpRequest);
});

afterEach(() => { vi.unstubAllGlobals(); });

function file(name: string, size = 4): File {
  const f = new File(['abcd'], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('useUploads', () => {
  it('POSTs each file to the uploads route with the name in the query', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a b.png'), file('c.txt')]); });

    expect(xhrs).toHaveLength(2);
    expect(xhrs[0]!.method).toBe('POST');
    // encodeURIComponent, so a space is %20 (not the +-form URLSearchParams gives).
    expect(xhrs[0]!.url).toBe('/api/forges/f1/uploads?name=a%20b.png');
    expect(xhrs[1]!.url).toBe('/api/forges/f1/uploads?name=c.txt');
    expect(result.current.items.map((i) => i.status)).toEqual(['uploading', 'uploading']);
  });

  it('tracks progress percentage', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    act(() => { xhrs[0]!.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 }); });
    expect(result.current.items[0]!.percent).toBe(25);
  });

  it('reports the resolved path and calls onUploaded on success', () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads('f1', onUploaded));
    act(() => { result.current.start([file('a.png')]); });
    act(() => {
      xhrs[0]!.status = 200;
      xhrs[0]!.responseText = JSON.stringify({ path: 'uploads/a.png' });
      xhrs[0]!.onload?.();
    });
    expect(onUploaded).toHaveBeenCalledWith('uploads/a.png');
    expect(result.current.items[0]).toMatchObject({ status: 'done', path: 'uploads/a.png' });
  });

  it('surfaces the server error message on failure', () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads('f1', onUploaded));
    act(() => { result.current.start([file('a.png')]); });
    act(() => {
      xhrs[0]!.status = 409;
      xhrs[0]!.responseText = JSON.stringify({ error: 'Forge is not running; start the forge first' });
      xhrs[0]!.onload?.();
    });
    expect(onUploaded).not.toHaveBeenCalled();
    expect(result.current.items[0]).toMatchObject({
      status: 'error', error: 'Forge is not running; start the forge first',
    });
  });

  it('rejects an oversize file client-side without opening a request', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('huge.bin', 200 * 1024 * 1024)]); });
    expect(xhrs).toHaveLength(0);
    expect(result.current.items[0]).toMatchObject({ status: 'error' });
    expect(result.current.items[0]!.error).toMatch(/100 MB/);
  });

  it('cancel aborts the request and marks the item errored', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    const key = result.current.items[0]!.key;
    act(() => { result.current.cancel(key); });
    expect(result.current.items[0]).toMatchObject({ status: 'error', error: 'Cancelled' });
  });

  it('dismiss removes an item from the list', () => {
    const { result } = renderHook(() => useUploads('f1', vi.fn()));
    act(() => { result.current.start([file('a.png')]); });
    const key = result.current.items[0]!.key;
    act(() => { result.current.dismiss(key); });
    expect(result.current.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(app)/forges/[id]/useUploads.test.ts" --config vitest.unit.config.ts`
Expected: FAIL — cannot resolve `./useUploads`.

- [ ] **Step 3: Implement**

Create `app/(app)/forges/[id]/useUploads.ts`:

```ts
'use client';

import { useCallback, useRef, useState } from 'react';
import { UPLOAD_BYTE_LIMIT } from '@/lib/runtime/upload-name';

export type UploadItem = {
  key: number;
  name: string;
  percent: number;
  status: 'uploading' | 'done' | 'error';
  path?: string;
  error?: string;
};

export type UploadsApi = {
  items: UploadItem[];
  start: (files: File[]) => void;
  cancel: (key: number) => void;
  dismiss: (key: number) => void;
};

/** Milliseconds a completed line lingers before it clears itself. */
const DONE_LINGER_MS = 5_000;

/**
 * Upload files to a forge's workspace, one request per file.
 *
 * XMLHttpRequest rather than fetch: xhr.upload.onprogress is the only broadly
 * reliable upload-progress signal, and at a 100 MB cap a silent minute would
 * read as a hang.
 */
export function useUploads(forgeId: string, onUploaded: (path: string) => void): UploadsApi {
  const [items, setItems] = useState<UploadItem[]>([]);
  const nextKey = useRef(1);
  const xhrs = useRef(new Map<number, XMLHttpRequest>());

  const patch = useCallback((key: number, fields: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...fields } : it)));
  }, []);

  const dismiss = useCallback((key: number) => {
    xhrs.current.delete(key);
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  const start = useCallback((files: File[]) => {
    for (const f of files) {
      const key = nextKey.current++;
      setItems((prev) => [...prev, { key, name: f.name, percent: 0, status: 'uploading' }]);

      if (f.size > UPLOAD_BYTE_LIMIT) {
        patch(key, { status: 'error', error: `${f.name} is larger than the 100 MB limit` });
        continue;
      }

      const xhr = new XMLHttpRequest();
      xhrs.current.set(key, xhr);
      xhr.open('POST', `/api/forges/${forgeId}/uploads?name=${encodeURIComponent(f.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          patch(key, { percent: Math.round((e.loaded / e.total) * 100) });
        }
      };
      xhr.onload = () => {
        xhrs.current.delete(key);
        let parsed: { path?: string; error?: string } = {};
        try { parsed = JSON.parse(xhr.responseText) as typeof parsed; } catch { /* non-JSON */ }
        if (xhr.status === 200 && parsed.path) {
          patch(key, { status: 'done', percent: 100, path: parsed.path });
          onUploaded(parsed.path);
          setTimeout(() => dismiss(key), DONE_LINGER_MS);
        } else {
          patch(key, { status: 'error', error: parsed.error ?? `Upload failed (${xhr.status})` });
        }
      };
      xhr.onerror = () => {
        xhrs.current.delete(key);
        patch(key, { status: 'error', error: 'Network error' });
      };
      xhr.onabort = () => {
        xhrs.current.delete(key);
        patch(key, { status: 'error', error: 'Cancelled' });
      };
      xhr.send(f);
    }
  }, [forgeId, onUploaded, patch, dismiss]);

  const cancel = useCallback((key: number) => {
    const xhr = xhrs.current.get(key);
    if (xhr) xhr.abort();
    else patch(key, { status: 'error', error: 'Cancelled' });
  }, [patch]);

  return { items, start, cancel, dismiss };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "app/(app)/forges/[id]/useUploads.test.ts" --config vitest.unit.config.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/forges/[id]/useUploads.ts" "app/(app)/forges/[id]/useUploads.test.ts"
git commit -m "feat(forge-ui): useUploads hook with per-file progress and cancel"
```

---

### Task 8: Chat panel drop zone, paperclip, and progress strip

**Files:**
- Modify: `app/(app)/forges/[id]/ChatPanel.tsx`
- Modify: `app/(app)/forges/[id]/ForgePageClient.tsx:98`
- Test: `app/(app)/forges/[id]/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `useUploads` (Task 7), `session.send` from `useChatSession`.
- Produces: `ChatPanel` gains a **required** `canUpload: boolean` prop.

- [ ] **Step 1: Write the failing test**

Add to `app/(app)/forges/[id]/ChatPanel.test.tsx`. First, **add `canUpload={false}` to every existing `render(<ChatPanel …>)` call** (there are seven, at lines 49, 54, 62, 70, 77, 84, and 92) so the new required prop typechecks. Then append:

```ts
vi.mock('./useUploads', () => ({
  useUploads: vi.fn((_forgeId: string, onUploaded: (p: string) => void) => {
    lastOnUploaded = onUploaded;
    return { items: uploadItems, start: uploadStart, cancel: uploadCancel, dismiss: uploadDismiss };
  }),
}));
```

with these module-level bindings beside the existing `lastTerm` / `termKeyHandler` declarations:

```ts
let lastOnUploaded: ((p: string) => void) | null = null;
let uploadItems: import('./useUploads').UploadItem[] = [];
const uploadStart = vi.fn();
const uploadCancel = vi.fn();
const uploadDismiss = vi.fn();
```

and reset them in the existing `beforeEach`:

```ts
    lastOnUploaded = null; uploadItems = [];
```

Then the new cases:

```tsx
describe('ChatPanel uploads', () => {
  it('disables the paperclip when canUpload is false', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    expect(screen.getByRole('button', { name: /upload files/i })).toBeDisabled();
  });

  it('enables the paperclip when canUpload is true', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    expect(screen.getByRole('button', { name: /upload files/i })).toBeEnabled();
  });

  it('starts an upload for dropped files', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    const zone = screen.getByTestId('upload-dropzone');
    const f = new File(['x'], 'logo.png');
    fireEvent.drop(zone, { dataTransfer: { files: [f], types: ['Files'] } });
    expect(uploadStart).toHaveBeenCalledWith([f]);
  });

  it('ignores dropped files when canUpload is false', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    fireEvent.drop(screen.getByTestId('upload-dropzone'), {
      dataTransfer: { files: [new File(['x'], 'logo.png')], types: ['Files'] },
    });
    expect(uploadStart).not.toHaveBeenCalled();
  });

  it('writes the resolved path into the PTY with a trailing space and no newline', async () => {
    const send = vi.fn();
    await withSession({ status: 'open', send });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    act(() => { lastOnUploaded?.('uploads/logo.png'); });
    expect(send).toHaveBeenCalledWith('uploads/logo.png ');
    expect(send).not.toHaveBeenCalledWith(expect.stringContaining('\n'));
  });

  it('does not send to a closed session', async () => {
    const send = vi.fn();
    await withSession({ status: 'closed', send });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    act(() => { lastOnUploaded?.('uploads/logo.png'); });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders in-flight and failed upload lines', async () => {
    uploadItems = [
      { key: 1, name: 'big.bin', percent: 42, status: 'uploading' },
      { key: 2, name: 'bad.bin', percent: 0, status: 'error', error: 'Network error' },
    ];
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    expect(screen.getByText(/big\.bin/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(app)/forges/[id]/ChatPanel.test.tsx" --config vitest.unit.config.ts`
Expected: FAIL — no `upload-dropzone` testid, no "Upload files" button.

- [ ] **Step 3: Implement**

In `app/(app)/forges/[id]/ChatPanel.tsx`:

Add imports and the prop:

```tsx
import type { DragEvent } from 'react';
import { Paperclip, X } from 'lucide-react';
import { useUploads } from './useUploads';
```

`ChatPanel.tsx` imports named hooks from `react` and has no `React` namespace import, so use the named `DragEvent` type rather than `React.DragEvent`.

```tsx
type Props = {
  forgeId: string;
  conversationId: string | null;
  /** False when the forge isn't running or the user lacks write access. */
  canUpload: boolean;
};
```

```tsx
export function ChatPanel({ forgeId, conversationId, canUpload }: Props) {
```

After the `session` line, add the upload wiring. `sessionRef` keeps `onUploaded` stable so `useUploads` doesn't re-create its callbacks on every status change:

```tsx
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onUploaded = useCallback((path: string) => {
    // Type the path into Claude's prompt: trailing space, no newline, so the
    // user finishes the sentence and presses Enter themselves.
    if (sessionRef.current.status === 'open') sessionRef.current.send(`${path} `);
  }, []);
  const uploads = useUploads(forgeId, onUploaded);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadDisabledReason = canUpload ? null : 'Start the forge to upload files';

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (!canUpload) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) uploads.start(files);
  }
```

In the header, before the "End session" button:

```tsx
          <button
            type="button"
            aria-label="Upload files"
            title={uploadDisabledReason ?? 'Upload files into uploads/'}
            disabled={!canUpload}
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-0.5 rounded border border-border text-ink-faint hover:text-ink disabled:opacity-40"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) uploads.start(files);
              e.target.value = '';
            }}
          />
```

Below the auth banner, add the progress strip:

```tsx
      {uploads.items.length > 0 && (
        <div className="shrink-0 border-b border-border bg-surface-raised px-3 py-1.5 text-[11px]">
          {uploads.items.map((it) => (
            <div key={it.key} className="flex items-center gap-2">
              <span className="truncate text-ink-dim">{it.name}</span>
              {it.status === 'uploading' && <span className="text-ink-faint">{it.percent}%</span>}
              {it.status === 'done' && <span className="text-ink-faint">→ {it.path}</span>}
              {it.status === 'error' && <span className="text-[#d96868]">{it.error}</span>}
              <button
                type="button"
                aria-label={it.status === 'uploading' ? `Cancel ${it.name}` : `Dismiss ${it.name}`}
                onClick={() => (it.status === 'uploading' ? uploads.cancel(it.key) : uploads.dismiss(it.key))}
                className="ml-auto shrink-0 text-ink-faint hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
```

Wrap the xterm host in the drop zone. `onDragOver` **must** call `preventDefault()` or the browser navigates to the dropped file:

```tsx
      <div
        data-testid="upload-dropzone"
        onDragOver={(e) => { e.preventDefault(); if (canUpload) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className="relative flex-1 min-h-0"
      >
        <div data-testid="xterm-host" ref={hostRef} className="h-full w-full overflow-hidden bg-[#0c0e12] p-1" />
        {dragging && canUpload && (
          <div className="pointer-events-none absolute inset-2 grid place-items-center rounded border-2 border-dashed border-border-strong bg-black/40 text-[12px] text-ink">
            Drop files into uploads/
          </div>
        )}
      </div>
```

Keep the existing `<style>` scrollbar block as-is.

In `app/(app)/forges/[id]/ForgePageClient.tsx:98`, pass the prop:

```tsx
            <ChatPanel
              forgeId={forge.id}
              conversationId={activeId}
              canUpload={canWrite && runtime?.status === 'running'}
            />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "app/(app)/forges/[id]" --config vitest.unit.config.ts`
Expected: PASS — the 7 new cases plus every pre-existing `ChatPanel` / `ForgePageClient` test.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/forges/[id]/ChatPanel.tsx" "app/(app)/forges/[id]/ChatPanel.test.tsx" "app/(app)/forges/[id]/ForgePageClient.tsx"
git commit -m "feat(forge-ui): drag-drop and paperclip uploads in the chat panel"
```

---

### Task 9: End-to-end upload spec

**Files:**
- Create: `tests/e2e/forge-upload.spec.ts`

**Interfaces:**
- Consumes: everything above. Runs against `FakeContainerManager` — `playwright.config.ts:32` already forces `FORGE_RUNTIME_MODE: 'fake'`.

- [ ] **Step 1: Write the failing spec**

Create `tests/e2e/forge-upload.spec.ts` with the full fixture below. It is the same setup `tests/e2e/forge-orchestration.spec.ts` uses — the clone fixture must exist or container setup fails, and `maya.chen@crystalfountains.com` is a seeded `DEVELOPER` who owns the seeded forge:

```ts
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.CRYSTAL_FORGE_HOME ?? './.test-forge-home';
const SLUG = 'aquaflow-designer';
const FORGE_NAME = 'Aquaflow Designer';

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

async function prewarmCloneFixture() {
  const clone = path.resolve(HOME, 'clones', SLUG);
  await fs.mkdir(path.join(clone, '.git'), { recursive: true });
  await fs.mkdir(path.join(clone, 'node_modules'), { recursive: true });
  await fs.writeFile(
    path.join(clone, '.env.example'),
    'DATABASE_URL=postgres://crystal:crystal@localhost:5433/aquaflow_designer\n',
  );
  await fs.writeFile(
    path.join(clone, 'server.js'),
    `require('http').createServer(function(_,res){res.end('Welcome to ${FORGE_NAME}')}).listen(+(process.env.PORT||3000));\n`,
  );
  await fs.writeFile(
    path.join(clone, 'package.json'),
    JSON.stringify(
      { name: SLUG, scripts: { dev: 'node server.js', prisma: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  );
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await fs.rm(HOME, { recursive: true, force: true });
});

test('uploads a file into the forge workspace from the chat panel', async ({ page }) => {
  await devLogin(page, 'maya.chen@crystalfountains.com');
  await prewarmCloneFixture();

  await page.goto('/dashboard');
  const card = page.locator('article', { hasText: FORGE_NAME });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^start$/i }).click();
  await expect(card.getByText(/Running/i)).toBeVisible({ timeout: 60_000 });

  // Into edit mode, and open a conversation so the chat panel mounts.
  await card.getByRole('link', { name: /edit/i }).click();
  await page.getByRole('button', { name: /\+ new/i }).click();

  const paperclip = page.getByRole('button', { name: /upload files/i });
  await expect(paperclip).toBeEnabled();

  await page.setInputFiles('input[type=file]', {
    name: 'survey-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the e2e suite\n'),
  });

  // The progress line reports the resolved repo-relative path.
  await expect(page.getByText('uploads/survey-notes.txt')).toBeVisible({ timeout: 15_000 });

  await card.getByRole('button', { name: /^stop$/i }).click().catch(() => {});
});
```

Two notes for whoever writes this:
- The route into edit mode depends on how `ForgeCard` links out. `ForgeCard.tsx:96` shows the edit control's accessible name is `Edit <label>` — but that button opens the **settings modal**, not the Claude Code surface. Read `app/(app)/dashboard/ForgeCard.tsx` and pick the control that navigates to `/forges/<id>`; if none is convenient, `await page.goto('/forges/' + id)` using the id read from the card's `Open` link is a legitimate shortcut. Fix the selector to match reality rather than trusting `/edit/i` above.
- In fake mode there is no real PTY, so **do not** assert the path appears inside the terminal; the progress line is the observable contract. The path-into-prompt behaviour is covered by the `ChatPanel` unit test in Task 8.

- [ ] **Step 2: Run the spec**

Run: `pnpm e2e tests/e2e/forge-upload.spec.ts`

Unlike every other task here, this one is not red-then-green: Tasks 1-8 already implement the feature, so a passing run is the expected first outcome and confirms the layers integrate. A failure is a selector problem in the spec (or a genuine integration gap) — diagnose before changing anything.

- [ ] **Step 3: Make it pass**

Adjust selectors until green. Do not weaken the assertion on the resolved path — that string is the point of the test.

- [ ] **Step 4: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`
Expected: all four exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/forge-upload.spec.ts
git commit -m "test(e2e): upload a file into a running forge's workspace"
```

---

## Manual verification on the pilot

Automated tests never exercise a real `docker exec`, so do this once before calling the feature done. **Note that this working directory is the live pilot** (see the dev-on-pilot-host constraint in `AGENTS.md`): the dashboard must be restarted for server-side changes to take effect.

- [ ] Restart the dashboard: `sudo systemctl restart crystal-forge.service`
- [ ] Start a forge, open edit mode, create a conversation, wait for Claude's prompt.
- [ ] Drag a small image onto the terminal. Confirm: the dashed overlay appears during the drag, the progress line resolves to `uploads/<name>`, and the path is typed into the prompt **without submitting**.
- [ ] Ask Claude to `ls -l uploads/` and confirm the file is owned by `forge` — this is the property `docker cp` could not deliver.
- [ ] Drop a file with the same name again; confirm it becomes `<stem>-2<ext>`.
- [ ] Drop three files at once; confirm three progress lines and three paths appended.
- [ ] Stop the forge; confirm the paperclip is disabled with the "Start the forge to upload files" tooltip and that dropping does nothing.
- [ ] Start a large-ish file (say 50 MB), cancel it mid-flight, then ask Claude to `ls -a uploads/` — confirm **no** `.part` fragment and no partial file remain.

## Deferred (explicitly not in this plan)

Per the spec's non-goals: no git actions, no workspace file browser, no DB/audit record, no type allowlist, no clipboard-paste handler, no prod-mode uploads, no resumable uploads.
