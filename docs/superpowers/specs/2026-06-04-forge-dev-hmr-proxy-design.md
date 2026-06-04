# Forge dev-HMR through the preview proxy — Design

**Date:** 2026-06-04
**Status:** Approved (design); implementation plan pending
**Builds on:** `2026-06-02-forge-preview-path-routing-design.md` (the same-origin `/app/<slug>` proxy) and `2026-06-03-forge-docker-isolation-design.md` (per-forge containers).

## Context

A running forge is served same-origin at `/app/<slug>/` by an in-app reverse proxy
(`app/app/[slug]/[[...path]]/route.ts` → `lib/runtime/preview-proxy.ts`). That proxy is a
Next.js **App Router route handler**, which can only do HTTP `fetch()` — it cannot handle a
WebSocket `upgrade`, and it explicitly strips the `upgrade` header.

The 2026-06-02 spec accepted "no HMR through the proxy" as a tradeoff, assuming the only cost
was losing hot-reload. The per-forge container work then revealed a worse consequence: in
**dev mode**, Next 16 / Turbopack's client bootstrap opens the Fast Refresh HMR WebSocket as
part of startup. When that socket can't connect through the proxy, the dev client `init`
aborts and **React never hydrates** — so the preview renders server-side but is completely
non-interactive (buttons dead, no client logs). Confirmed empirically: the same forge served
in **production mode** (no HMR socket) hydrates and works perfectly through the unchanged HTTP
proxy.

A second Next 16 dev-security feature compounds it: **`allowedDevOrigins`** blocks
cross-origin dev requests (HMR, `/_next/*`) and "the page never hydrates" unless the
requesting origin is allowlisted. The dashboard already works around this for itself
(`next.config.ts`); a forge served cross-origin through the proxy hits the same wall.

## Environments (drives the design)

- **LOCAL** (Mac): dashboard development; forges run to validate end-to-end. Hot-reload is a
  nice-to-have here.
- **PILOT** (`forge-pilot.crystalfountains.com`, Ubuntu, **nginx present**): where advanced
  business users iterate on their forges with the agent. **Hot-reload matters most here.**
- **PROD** (future): forges deployed as production builds for end users; promotion path + DB
  migration are TBD.

Forges run in **dev mode** on LOCAL and PILOT (this spec makes dev mode work behind the
proxy). PROD will run forges as **production builds** (no dev server, no HMR, `allowedDevOrigins`
irrelevant) — out of scope here.

## Goal

Make a dev-mode forge fully work behind the same-origin proxy — both **hydrate** and
**hot-reload** — on LOCAL and PILOT, while preserving the dashboard's authentication + per-forge
read-ACL gate and requiring **no per-forge nginx configuration**.

## Non-goals / accepted tradeoffs

- **PROD production-build mode and the pilot→prod promotion/DB-migration path** are future work.
- **Running the dashboard under a custom server disables Next's Automatic Static Optimization**
  for the dashboard's own pages — an accepted, modest cost. (The dashboard does not use
  `output: 'standalone'`, so the custom-server/standalone incompatibility does not apply.)
- The terminal WebSocket server (separate process on `CRYSTAL_FORGE_WS_PORT`) is left as-is;
  this spec only adds forge-preview HMR on the dashboard origin.

## Architecture

```
Browser ──(HTTP + WS)──▶ [PILOT only: nginx, ws-passthrough headers] ──▶ Dashboard custom server (:3030)
                                                                          ├─ HTTP /app/<slug>/*        → Next route handler → forge (existing)
                                                                          ├─ WS   /app/<slug>/_next/... → upgrade tunnel → forge dev ws  (NEW)
                                                                          └─ WS   /_next/webpack-hmr    → Next (dashboard's own HMR, unchanged)
                                                                                   │ auth(session) + forge read-ACL + slug→port (state.json)
                                                                                   ▼
                                                                          forge container dev server
                                                                            (127.0.0.1:<port>, basePath=/app/<slug>,
                                                                             allowedDevOrigins ⊇ dashboard/pilot host)
```

nginx on PILOT already forwards all traffic to the dashboard; it only needs the standard
WebSocket upgrade headers so the upgrade reaches the custom server. No per-forge nginx config,
no forge-port exposure (ports stay loopback-bound). On LOCAL there is no nginx — the browser
hits the custom server directly, so the same tunnel serves local HMR for free.

## Components

### 1. Dashboard custom server (`server.ts`)

A thin Node server replacing `next dev` / `next start` for the dashboard:

```ts
const app = next({ dev });                 // dev = NODE_ENV !== 'production'
const handle = app.getRequestHandler();
await app.prepare();
const server = http.createServer((req, res) => handle(req, res));
server.on('upgrade', dispatchUpgrade);     // see below
server.listen(port);
```

- Run via `tsx server.ts` (the repo already depends on `tsx`). `package.json` scripts change to
  `dev: "tsx server.ts"` and `start: "NODE_ENV=production tsx server.ts"`; `build: "next build"`
  is unchanged. `forge-launch.sh`'s `exec pnpm dev` continues to work (it calls the `dev` script).
- The `upgrade` dispatcher routes by path:
  - matches `^/app/[^/]+/` → forge HMR tunnel (component 2);
  - otherwise → delegate to Next's own upgrade handling so the **dashboard's** Fast Refresh keeps
    working. (Use Next's upgrade handler if exposed by the installed version; otherwise let Next's
    own `upgrade` listener — registered when the server is passed to Next — handle it, and ensure
    our handler does not touch non-`/app` sockets.)

### 2. Forge HMR WebSocket tunnel (`lib/runtime/hmr-proxy.ts`)

A `handleForgeUpgrade(req, socket, head, deps)` that mirrors the HTTP proxy's gate, then pipes:

1. **Authenticate:** resolve the dashboard session from the upgrade request's cookies; no session
   → close the socket (`4401`).
2. **Resolve slug → entry:** parse `<slug>` from the path; `loadState()`; require a matching
   entry with `status === 'running'` → else close (`4404`).
3. **Read-ACL:** load the forge by `entry.forgeId`; `canReadForge(user, acl)` → else close (`4404`,
   no existence disclosure).
4. **Tunnel:** open a client `WebSocket` to `runtimeOrigin(entry.port)` + the **same path**
   (`/app/<slug>/_next/webpack-hmr…`, preserved because the forge runs with that `basePath`), using
   the existing `ws` dependency, and relay frames + close in both directions. Set the outgoing
   `Origin` to the dashboard origin so the forge's `allowedDevOrigins` check passes.

Dependencies (`getSession`, `loadState`, `loadForgeAcl`) are injected, matching the
`PreviewProxyDeps` pattern, so the gate is unit-testable with fakes.

### 3. `allowedDevOrigins` injection (companion fix)

Without this, Next 16 in the forge container rejects the tunneled cross-origin dev requests and
the page still won't hydrate. Extend the clone-time `next.config` wrapper (which already injects
`basePath` from `FORGE_BASE_PATH`) to also inject dev origins from an env var:

```ts
// crystal-forge: basePath + dev origins injected for the reverse proxy. Do not edit.
import base from './next.config.base';
const basePath = process.env.FORGE_BASE_PATH || undefined;
const allowedDevOrigins = (process.env.FORGE_DEV_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
export default {
  ...base,
  basePath,
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
};
```

The runtime (`lib/services/runtime.ts` / `container-setup.ts` env) sets `FORGE_DEV_ORIGINS` to the
**specific** dashboard/pilot host(s) — never `*`. The value comes from dashboard config/env
(e.g. reuse the host list the dashboard's own `allowedDevOrigins` uses, plus the pilot host).

This injection lives in the **same wrapper file** as `basePath`. The current container-setup
writes that wrapper via a `node -e` script; that script's `WRAPPER` constant is updated to the
form above. It stays idempotent (the `next.config.base.ts` marker is unchanged).

### 4. nginx on PILOT (documentation only, no code)

Document that the existing `location` forwarding to the dashboard must carry:
`proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";` (with
HTTP/1.1) so WebSocket upgrades for `/app/<slug>/_next/webpack-hmr` reach the custom server. This
is a one-time, non-per-forge addition to the existing server block.

### 5. Revert the temporary prod-mode hack

`bmodi-test3` was manually switched to `next build && next start` to confirm the diagnosis. Once
this lands, forges run **dev mode** again (the supervised `pnpm dev` from the container-isolation
work), now hydrating and hot-reloading through the tunnel.

## Auth / security model

- The HMR tunnel reuses the **same gate** as the HTTP proxy: dashboard session + per-forge
  read-ACL. The WebSocket is therefore exactly as protected as the page — a user can only tunnel
  to a forge they may read; an outsider gets a closed socket.
- `allowedDevOrigins` is a **dev-server-only** setting (no effect on production builds). The dev
  endpoints it exposes (HMR, `/_next/*`, source maps) reveal only the forge's **own** source,
  which the authorized user already owns. Risk is contained by: allowlisting **specific
  hostnames** (never `*`), **loopback-bound** forge ports (only the dashboard host reaches them),
  and the **auth+ACL gate** in front of the tunnel.
- PROD forges run production builds → no dev server, no HMR, no `allowedDevOrigins` surface.

## Testing

- **Unit (Vitest, colocated):**
  - Upgrade **dispatcher**: `/app/<slug>/_next/webpack-hmr` routes to the tunnel with the correct
    target URL; `/_next/webpack-hmr` and other paths delegate to Next (not destroyed).
  - Tunnel **gate** (`hmr-proxy.ts`): no session → close `4401`; unknown/stopped slug → close
    `4404`; ACL-denied → close `4404`; allowed → opens a client socket to
    `runtimeOrigin(port)+path`. Use injected fake `getSession`/`loadState`/`loadForgeAcl` and a fake
    WebSocket, mirroring `preview-proxy.test.ts`.
  - **Wrapper injection**: `FORGE_DEV_ORIGINS` set → `allowedDevOrigins` array present; unset →
    omitted; `basePath` still injected; idempotent re-run. Mirror the existing basePath test.
- **De-risk step (first task):** stand up the bare `server.ts`, confirm Next 16 + Turbopack dev
  runs under it — dashboard loads, dashboard's **own** HMR still works — before adding any tunnel
  code. If this fails, fall back to the standalone WS-proxy-service + nginx for PILOT and prod-mode
  for LOCAL.
- **Manual / e2e:** with a forge running, load `/app/<slug>/<route>`, confirm the page is
  interactive (the earlier calculator computes), then edit a component and confirm the preview
  **hot-updates without a refresh**; confirm the browser console shows the HMR socket connected
  (no repeated `webpack-hmr failed`).

## Rollout / phasing

1. Bare custom server + Next-16-under-custom-server validation (de-risk).
2. Upgrade dispatcher + forge HMR tunnel (`hmr-proxy.ts`) with the gate.
3. `allowedDevOrigins` injection (wrapper + `FORGE_DEV_ORIGINS` runtime env).
4. Revert forges to dev mode; nginx doc note for PILOT.
5. Manual/e2e verification of hydrate + hot-reload on LOCAL (and PILOT).

## Affected files

- `server.ts` — new dashboard custom server (HTTP via Next + upgrade dispatcher).
- `package.json` — `dev`/`start` scripts → `tsx server.ts`.
- `lib/runtime/hmr-proxy.ts` — new forge HMR WS tunnel + gate (+ tests).
- `lib/runtime/container-setup.ts` — wrapper `WRAPPER` constant gains `allowedDevOrigins` (+ test).
- `lib/services/runtime.ts` — set `FORGE_DEV_ORIGINS` in the container env (alongside
  `FORGE_BASE_PATH`).
- `lib/env.ts` — config for the dashboard/pilot dev origins passed to forges (or reuse the
  dashboard's existing host list).
- `docs/` / deployment notes — nginx WebSocket-passthrough header note for PILOT.

## Fallback (if the custom server proves unviable on Next 16)

Keep the dashboard on `next dev`/`next start`; add a **standalone WS-proxy service** (sibling to
the terminal WS server) that does the same auth+ACL+slug→port+tunnel. On PILOT, nginx routes
`location ~ ^/app/[^/]+/_next/webpack-hmr` to it (one regex block, no per-forge config). On LOCAL
(no nginx), forge previews run in **production mode** (interactive, no HMR) or use the direct
loopback port for hot-reload. This sacrifices the single-code-path/local-mirrors-pilot property,
so it is the fallback, not the primary.
