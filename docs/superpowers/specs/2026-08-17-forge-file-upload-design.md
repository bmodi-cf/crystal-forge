# Crystal Forge — File Upload into a Forge Workspace Design

- **Date:** 2026-08-17
- **Status:** Draft, awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Upload files from the browser into a running forge's checkout, from the Claude Code edit surface (`/forges/[id]`)

## 1. Summary

While working in a forge's edit mode — the Claude Code PTY at `/forges/[id]` — the user can drag files onto the chat panel (or pick them with a paperclip button) and have them land in the forge's checkout at `/workspace/uploads/`. As each upload completes, its repo-relative path is typed into Claude's prompt so the next message can reference it naturally ("crop this logo to a square").

Uploads land in the **working tree only**. Nothing is committed or pushed; the file simply appears as an untracked change that Claude can then read, move, or commit under the user's direction.

The transfer reuses the mechanism that already carries every setup command and the agent PTY — `docker exec` into the forge container — exposed as a narrow new `ContainerManager.writeUpload()` method that streams the request body to `cat` inside the container.

## 2. Goals & Non-Goals

### Goals

- Drag-and-drop onto the chat panel and a paperclip button in its header, both funnelling into one upload path.
- Files land at `/workspace/uploads/<name>`, with numeric suffixes on collision (`logo.png` → `logo-2.png`).
- Multiple files at once, uploaded concurrently, each with its own progress and cancel.
- The resolved repo-relative path is written into the Claude prompt on completion — with a trailing space and **no** newline, so nothing auto-submits.
- Nothing is buffered in the dashboard's heap: a 100 MB upload streams request → container.
- Correct ownership inside the container: uploaded files are owned by `forge`, the user Claude runs as, so Claude can move or delete them.
- `containerId` stays server-side, preserving the boundary `RuntimeStateView` establishes (`lib/runtime/types.ts:26`).
- Testable with no docker, via `FakeContainerManager`.

### Non-Goals (this slice)

- **No git action.** No commit, no push, no branch handling, no staging. The file is left untracked for Claude to handle.
- **No workspace browser.** No listing, renaming, moving, downloading, or deleting of files through the dashboard. A files panel is a separate, larger feature and would swallow this one's scope.
- **No database record.** No `ForgeUpload` table, no migration, no audit UI. The working tree is the record; git history captures the file once Claude commits it.
- **No type allowlist.** Any file type is accepted (see §7).
- **No clipboard paste handler.** Drag-and-drop and the file picker only.
- **No prod-mode uploads.** Edit mode is dev-mode-only, and the route carries `devOnlyRouteGuard()` like its neighbours.
- **No upload without a running container.** There is nowhere to write otherwise; the UI disables and the service rejects.
- **No resumable or chunked uploads.** A failed upload is retried by dropping the file again.

## 3. Architecture

### Module layout

```
lib/runtime/container/
├── types.ts                     # MODIFIED — writeUpload() on ContainerManager
├── docker-container-manager.ts  # MODIFIED — streaming spawn implementation
└── fake-container-manager.ts    # MODIFIED — in-memory uploads + same collision rule

lib/services/
└── runtime.ts                   # MODIFIED — uploadToWorkspace() service

app/api/forges/[id]/uploads/
└── route.ts                     # NEW — POST, streams body to the service

app/(app)/forges/[id]/
├── ForgePageClient.tsx          # MODIFIED — passes canUpload to ChatPanel
├── ChatPanel.tsx                # MODIFIED — drop zone, paperclip, progress strip
└── useUploads.ts                # NEW — XHR upload queue + progress state
```

### Data flow

```
File drop / picker
  → useUploads: per-file XHR
    → POST /api/forges/[id]/uploads?name=logo.png   (raw body, not multipart)
      → devOnlyRouteGuard() → auth() → uploadToWorkspace()
        → canWriteForge() → loadRuntimeHandle() → status must be 'running'
          → containerManager.writeUpload(containerId, { name, body })
            → docker exec -i -w /workspace -e UPLOAD_NAME=… <id> sh -c '<script>'
              → resolve non-colliding name → cat > tmp → mv into place
              → print resolved path on stdout
          ← { path: 'uploads/logo.png' }
    ← 200 { path }
  → session.send('uploads/logo.png ')   // typed into Claude's prompt
```

### Why `docker exec`, not `docker cp`

`docker cp` into a container needs a tar stream on stdin (no tar library is in `package.json`) or a host temp file first, and it lands files owned by **root** — Claude, running as `forge`, could not then delete what the user uploaded. The forge image ends with `USER forge` (`docker/forge-runtime.Dockerfile:35`), so `docker exec` runs as `forge` and gets ownership right with no extra flags.

### Why a new method rather than extending `exec`

`ContainerManager.exec()` delegates to `childProcessRunner`, which hard-codes `stdio: ['ignore', fd, fd]` (`lib/runtime/child-process-runner.ts:12`) — no stdin, no stdout capture. Threading both through the shared runner would touch every container setup step and the agent PTY for the benefit of one caller. `writeUpload` therefore spawns directly, wiring stdin from the request and reading the resolved path off stdout, and leaves the existing exec path untouched.

## 4. The container-side script

Invoked as:

```
docker exec -i -w /workspace -e UPLOAD_NAME=<sanitized name> <containerId> sh -c '<script>'
```

The script, in POSIX `sh`:

1. `mkdir -p uploads`
2. Split `$UPLOAD_NAME` into stem and extension; loop `while [ -e "uploads/$cand" ]` appending `-2`, `-3`, … until free.
3. `tmp="uploads/.$cand.part"`; `trap 'rm -f "$tmp"' EXIT`
4. `cat > "$tmp"` — the request body arrives on stdin.
5. `mv "$tmp" "uploads/$cand"` on success only.
6. `printf '%s\n' "uploads/$cand"` on stdout.

Two properties worth stating:

- **The filename never enters the command string.** It travels as an env var, so there is no quoting or shell-injection surface regardless of what the file is called. Sanitization (§7) is about producing sane filenames, not about escaping.
- **A partial file never appears under its real name.** A dropped connection, full volume, or killed container leaves `uploads/` exactly as it was, rather than a truncated `logo.png` that looks complete to Claude.

## 5. Interfaces

### `ContainerManager` (lib/runtime/container/types.ts)

```ts
export type ContainerManager = {
  // … existing members unchanged …
  /**
   * Stream `body` into <workdir>/uploads/, resolving name collisions.
   * Returns the resolved repo-relative path (e.g. 'uploads/logo-2.png').
   */
  writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }>;
};
```

`DockerDeps` gains one injectable seam for the streaming spawn, matching the existing `capture` / `runner` pattern, so the docker implementation is unit-testable.

`FakeContainerManager` records `{ name, bytes }` per container in a map and applies the same collision rule, so services, routes, and e2e run with no docker.

### Service (lib/services/runtime.ts)

```ts
export async function uploadToWorkspace(
  currentUser: SessionUser,
  forgeId: string,
  name: string,
  body: Readable,
  byteLimit?: number,
): Promise<{ path: string }>;
```

Resolves the forge, enforces `canWriteForge` (throwing `ForbiddenError`, as its neighbours at `lib/services/runtime.ts:77` and `:218` do), reads `loadRuntimeHandle(forgeId)` for the `containerId`, rejects unless the runtime is `running`, sanitizes the name, and delegates to `writeUpload`.

`byteLimit` defaults to 100 MB and the **service** is the single server-side enforcer: it counts bytes as they stream and destroys the stream on overrun, throwing an error the route maps to 413. The route's only cap-related job is the cheap `Content-Length` pre-check, so oversize requests with an honest length header are refused before any container work begins.

Uploads are **serialized per forge** through a small in-process promise chain keyed by `forgeId`. This closes the only real race — two files resolving the same candidate name concurrently — and the dashboard being a single process makes it sufficient without lockfiles.

### Route (app/api/forges/[id]/uploads/route.ts)

`POST /api/forges/[id]/uploads?name=<filename>`

Mirrors `app/api/forges/[id]/conversations/route.ts`: `devOnlyRouteGuard()`, then `auth()`, then the service call wrapped in `respondToServiceError`.

The body is **raw bytes, one file per request** — deliberately not `multipart/form-data`, because `request.formData()` buffers the entire file in memory and the cap is 100 MB. `Readable.fromWeb(req.body)` feeds the child's stdin directly. Multi-file drops become N concurrent requests, which is also what makes per-file progress possible.

The route listens on the request's abort signal and kills the child, whose `trap` removes the fragment.

## 6. UI and interaction

`ChatPanel` gains one prop from `ForgePageClient`, which already holds both facts:

```tsx
<ChatPanel forgeId={forge.id} conversationId={activeId}
           canUpload={canWrite && runtime?.status === 'running'} />
```

- **Drop zone.** A wrapper around the xterm host handles `dragover` / `dragleave` / `drop`, calling `preventDefault()` on `dragover` (without it the browser navigates to the file). While a drag is over it, a dashed overlay reads *"Drop files into uploads/"*.
- **Paperclip.** A button in the panel header beside "End session", opening a hidden `<input type="file" multiple>`.
- **Transport.** `XMLHttpRequest`, not `fetch` — `xhr.upload.onprogress` is the only broadly reliable upload-progress signal, and at a 100 MB cap a long silent stall would read as a hang. One XHR per file, all in flight together.
- **Progress strip.** A thin row between the header and the terminal: one line per in-flight file with name, percentage, and a cancel ✕ that aborts the XHR. Completed lines linger ~5s showing the resolved path, then fade; failed lines stay until dismissed.
- **Path injection.** On completion, `session.send('uploads/logo.png ')` — path plus trailing space, written into the prompt as if typed. Repo-relative rather than `/workspace/uploads/…`, because Claude's cwd *is* `/workspace` and the short form is what a transcript should read like. **No trailing newline: nothing auto-submits.** Several files append several paths as they land.
- **No socket, still fine.** Upload needs the *container*, not the PTY. With the socket closed the upload still succeeds; the path stays on the progress line, selectable, instead of being injected.
- **Disabled states.** With `canUpload` false the paperclip is disabled and drops are ignored, with the reason in a tooltip: "Start the forge to upload files" when stopped, "Read-only access" when it is a permissions matter.

## 7. Constraints, errors, and edge cases

**Size cap: 100 MB per file.** The client rejects oversize files before starting (instant feedback, no wasted bytes) — UX only, not a boundary. Server-side, the route does a cheap `Content-Length` pre-check and the service is the authoritative enforcer, counting bytes mid-stream and aborting on overrun (§5). Both server paths surface as 413.

**No type allowlist.** Anyone who can upload already has a shell in that container through Claude Code, so an allowlist is not a security boundary — it would only one day block a legitimate file.

**Name sanitization** (server-side, authoritative): basename only, so `../../etc/passwd` becomes `passwd`; control characters and newlines stripped; length capped at 255 bytes; empty or `.` / `..` after sanitizing falls back to `upload`.

**No fixed timeout.** A legitimate 100 MB upload over a slow link can take minutes; the request lifecycle is the only bound.

**Status codes:**

| Condition | Response |
|---|---|
| Not signed in | 401 |
| Prod mode | 404 (`devOnlyRouteGuard`) |
| Not forge owner or admin | 403 (`ForbiddenError`) |
| Runtime not `running` | 409, "Start the forge first" |
| Over 100 MB | 413 |
| Disk full, container died, other exec failure | 500 with the shell's stderr |

**Accepted consequences:**

- `uploads/` is a real, committable directory. If Claude runs `git add -A`, uploads go with it. That is the cost of the visible-in-`git status` behaviour that makes an upload's arrival observable, and it was chosen over a hidden gitignored directory.
- `uploads/` accumulates over a forge's life. Cleanup is a one-sentence request to Claude, not a feature here.
- If a forge's own `.gitignore` happens to ignore `uploads/`, the file will not show in `git status`. Not fought.
- Uploads live on the workspace volume, which survives container recreation (per `AGENTS.md`), so they persist across stop/start.

## 8. Testing

Colocated Vitest, following the existing suites:

- **`lib/runtime/container/docker-container-manager.test.ts`** — `writeUpload` builds the expected argv (`-i`, `-w /workspace`, name via `-e UPLOAD_NAME` and never interpolated into the script), pipes stdin through, and parses the resolved path off stdout; non-zero exit rejects.
- **`lib/runtime/container/fake-container-manager.test.ts`** — collision suffixing (`logo.png` → `logo-2.png` → `logo-3.png`).
- **`lib/services/runtime.test.ts`** — non-owner gets `ForbiddenError`; stopped runtime rejects; sanitization table (traversal, control chars, empty, 300-char name); oversize rejection; two same-name uploads serialize to distinct paths.
- **Route test** — 401 unauthenticated, 404 in prod mode, 413 oversize.
- **`app/(app)/forges/[id]/ChatPanel.test.tsx`** — paperclip disabled with the right tooltip per reason; a synthetic `drop` triggers upload; the resolved path reaches `session.send` with a trailing space and no newline; progress line renders; a failed line persists.
- **E2E** (`tests/e2e/forge-upload.spec.ts`) — `playwright.config.ts:32` already forces `FORGE_RUNTIME_MODE: 'fake'`, so a running forge in fake mode can take a real upload through the file input; assert the path lands in the terminal and the progress line clears.

## 9. Open questions

None. Decisions settled during design: working-tree only (no git action), drag-and-drop plus paperclip, `uploads/` with numeric collision suffixes, 100 MB cap with no type restrictions, no database record.
