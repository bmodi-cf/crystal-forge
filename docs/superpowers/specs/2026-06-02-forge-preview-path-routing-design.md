# Forge preview path-based routing — design

**Date:** 2026-06-02
**Status:** Approved for planning

## Problem

When a forge runtime is running, the dashboard links to its live app with a hardcoded
`http://localhost:${runtime.port}` URL in two places:

- `app/(app)/forges/[id]/InstancePanel.tsx` — the embedded `<iframe>` preview and a
  "standalone" link.
- `app/(app)/dashboard/ForgeCardRuntime.tsx` — the "Open" link.

This only works when the browser is on the same machine as the runtime. On the pilot server
(`https://forge-pilot.crystalfountains.com`) a remote user's browser resolves `localhost` to
their *own* machine, so the preview is broken. The runtime ports (3001–3099) are bound to
loopback on the server and are not — and should not be — exposed to the internet.

## Goal

Serve each running forge's live app at a same-origin path:

```
https://forge-pilot.crystalfountains.com/app/<slug>/
```

where `<slug>` is the forge slug (e.g. `bmodi-test1`). This must work for remote users over
HTTPS, require no per-forge nginx configuration, expose no runtime ports to the internet, and
gate preview access through the existing access-control model.

## Non-goals / accepted tradeoffs

- **HMR / live-reload does not tunnel through the proxy.** A Next.js route handler cannot
  proxy the dev server's WebSocket upgrade, so the forge app's hot-reload will not work in the
  preview. This is accepted: the preview shows the running app, and the planned move to
  per-forge Docker containers would break HMR through the proxy anyway.
- **Per-request ACL adds a DB lookup per proxied request** (including each asset). Acceptable
  at pilot scale; can be cached later if it becomes a bottleneck.
- **App-level identity / per-user authorization inside forge apps is out of scope.** It is
  described under "Future work" because the current design must be forward-compatible with it,
  but none of it is built now.

## Architecture overview

```
Browser ──HTTPS──▶ nginx (TLS term) ──▶ Crystal Forge (next start)
                                              │
                                  /app/<slug>/* catch-all route
                                              │ authN (Entra session) + forge read-ACL
                                              │ slug → port (state.json)
                                              ▼
                                   http://127.0.0.1:<port>/app/<slug>/*
                                              │
                                   forge dev server (basePath=/app/<slug>)
```

nginx already terminates TLS for the domain and forwards everything to the Crystal Forge app.
`/app/<slug>` is just another path the dashboard handles, so **nginx needs no per-forge config
and no port exposure**. The 3001–3099 range stays bound to loopback.

### Local development (no nginx required)

The reverse proxy lives **inside the Crystal Forge app**, not in nginx — nginx is a pilot-only
TLS front door. Locally there is no nginx: the browser hits the Next dev server directly and
the same `/app/<slug>` route handles the request.

```
Pilot:  browser ──HTTPS──▶ nginx ──▶ Next app ──▶ /app/<slug> route ──▶ 127.0.0.1:<port>
Local:  browser ──HTTP─────────────▶ Next dev ──▶ /app/<slug> route ──▶ 127.0.0.1:<port>
```

Because the UI links are **relative** (`/app/<slug>/`), they resolve to `http://localhost:3000`
in dev and `https://forge-pilot.…` on the pilot automatically — no environment branching and no
localhost assumption anywhere. Local and pilot share one code path, so local behavior mirrors
the pilot.

**Decision: always proxy** (no dev-only direct-port escape hatch). This keeps a single code
path and makes local match the pilot. The consequence is that HMR is lost in the local embedded
preview too (not just on the pilot); a developer iterating on a forge app can open its
`localhost:<port>` directly in a separate tab when they want hot-reload.

## Components

### 1. basePath injection at clone time

**Why:** A Next.js app proxied under `/app/<slug>` must know its `basePath`, or it emits asset
and API URLs at `/_next/*` and `/api/*`, which escape the prefix and break (they would hit the
dashboard instead of the forge app).

**What:** In `lib/runtime/clone.ts` (`ensureClone`), add an idempotent step that wraps the
cloned `next.config.ts` so it injects `basePath` from an environment variable:

- If `next.config.base.ts` does **not** exist (the idempotency marker):
  - Rename the existing `next.config.ts` → `next.config.base.ts`.
  - Write a new `next.config.ts` that imports the base config and injects `basePath`:

    ```ts
    // crystal-forge: basePath injected for path-based reverse proxy. Do not edit.
    import base from './next.config.base';
    const basePath = process.env.FORGE_BASE_PATH || undefined;
    export default { ...base, basePath };
    ```

- If `next.config.base.ts` already exists, do nothing (idempotent — safe to run on every
  `ensureClone`, including the already-cloned `bmodi-test1`).

**Notes / assumptions:**

- The template's default export is a config **object** (confirmed: current `next.config.ts` is
  `const nextConfig: NextConfig = {}; export default nextConfig;`). The spread `{ ...base }`
  assumes an object, not a function. If a future template exports a function, the wrapper must
  be revisited — the patch step should detect a non-object default and skip with a logged
  warning rather than produce a broken config.
- Reading `basePath` from `process.env.FORGE_BASE_PATH` keeps the patched file **generic**
  (identical for every forge, no slug baked in), which is what makes it idempotent and simple.
- `basePath` must start with `/` and have no trailing slash (`/app/bmodi-test1`). Next.js
  applies it to `/_next/*` automatically; no separate `assetPrefix` is needed.

### 2. Spawn env

In `lib/services/runtime.ts` (`doStart`), add `FORGE_BASE_PATH: '/app/' + slug` to the spawn
env passed to the dev server (alongside the existing `PORT` and `NEXT_TELEMETRY_DISABLED`).

### 3. In-app reverse proxy

**New file:** `app/app/[slug]/[[...path]]/route.ts` — a catch-all route handler.

- `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.
- Exports handlers for all methods used by a web app: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `HEAD`, `OPTIONS` — all delegating to one internal `proxy(req, ctx)` function.
- This path does **not** collide with the `(app)` route group (route-group parens are excluded
  from the URL); `/app/...` is currently unused. The optional catch-all `[[...path]]` matches
  both `/app/<slug>` and `/app/<slug>/a/b/c`.

`proxy()` behavior:

1. **Authenticate:** `const session = await auth()`. No session → `401` (matches the pattern in
   `app/api/forges/[id]/conversations/[conversationId]/connect/route.ts`).
2. **Resolve slug → entry:** `loadState()` and find the entry whose `slug === params.slug` and
   `status === 'running'`. Not found / not running → `404` with a small friendly body
   ("Forge is not running").
3. **Enforce read-ACL:** load the forge by `entry.forgeId` (with its groups) and call
   `canReadForge(session.user, acl)`. Not allowed → `404` (prefer 404 over 403 to avoid
   confirming existence). This is the gate: previews now respect access control, which the old
   localhost links never did.
4. **Proxy:** forward the request to `runtimeOrigin(slug) + req.nextUrl.pathname + search`,
   **preserving the full `/app/<slug>/...` path** (the forge app expects it because of
   `basePath`). Preserve method, query, request headers (minus hop-by-hop), and stream the
   request body for non-GET/HEAD. Stream the upstream response (status, headers minus
   hop-by-hop) back to the browser.
5. **Hop-by-hop headers** (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, etc.)
   are stripped in both directions. A WebSocket `upgrade` cannot be served here and results in
   a normal failed upgrade (HMR breakage — see non-goals).

**Proxy target indirection:** the upstream origin is computed by a single helper
`runtimeOrigin(slug)` (or `runtimeOrigin(entry)`), returning `http://127.0.0.1:<port>` today.
This is the **only** place that encodes "where the runtime lives," so the future Docker move
(container host:port on an internal network) is a one-function change.

### 4. UI link changes

Both components already receive `runtime: RuntimeStateView`, which includes `slug`.

- `app/(app)/forges/[id]/InstancePanel.tsx`: replace `http://localhost:${runtime.port}` with
  the relative path `/app/${runtime.slug}/` for both the `<iframe src>` and the "standalone"
  link. Update the `localhost:{port}` label text to show the path (e.g. `/app/${runtime.slug}`).
- `app/(app)/dashboard/ForgeCardRuntime.tsx`: replace the "Open" `href` with
  `/app/${runtime!.slug}/`.

Relative same-origin URLs work for both the iframe and the open-in-new-tab link and require no
host/env knowledge in the client.

## Auth model

The design establishes **central authentication, with the dashboard as the single gate**:

| Layer | Who authenticates | Entra redirect URI |
|---|---|---|
| Dashboard + the gate on `/app/<slug>` | Crystal Forge (Entra ID) | the one already registered |
| The running forge app | none (gated by the dashboard) | none needed |

- The **only** registered Entra redirect URI is the dashboard's
  (`${NEXTAUTH_URL}/api/auth/callback/microsoft-entra-id`). Because previews are **same-origin**
  with the dashboard, path routing adds **no** new Entra configuration.
- Forge apps must **never** become their own Entra clients: a per-app callback would be a
  slug-specific redirect URI, and Azure requires exact matches (no path wildcards), so every
  forge would need a manual Azure edit. This does not scale and is explicitly forbidden by the
  design.
- This is already enforced by the code: `ensureClone` seeds each clone's `.env.local` from
  `.env.example` (empty Entra credentials, `NEXTAUTH_URL=http://localhost`), **not** from the
  operator's real `.env.local`. The real client secret never reaches a clone, so a forge app
  cannot initiate a real Entra login.

### Operational checks (part of this work)

1. Confirm the forge template ships **no always-on auth** that activates without Entra (e.g. a
   dev-login mode keyed off `AUTH_DEV_USERS_ENABLED`). If it does, the clone-time patch (or the
   seeded `.env.local`) must disable it so forge apps are gated solely by the dashboard.
2. Confirm `.env.local` is gitignored (it holds a live Entra client secret).

## Future work — app-level identity (out of scope, design must accommodate)

Today the gate enforces *authentication* ("you are a known Entra user with access to this
forge"). A later phase will give forge apps the user's *identity* so each app can make its own
*authorization* decisions — e.g. a `ceo-kpi` app shows entry tables only to specific users and
a welcome screen to everyone else. This is **central authN, decentralized authZ**: the gate
authenticates once; each app applies its own rules to the same identity.

Chosen direction (to be designed/built separately):

- **Forwarded, signed identity.** The proxy (already the single auth chokepoint) injects the
  verified identity — stable `oid` (immutable Entra object id) + `email` + display name — and
  **HMAC-signs** it so a forge app can cryptographically verify it came from the gate, not just
  trust the network. Reuse the existing `signTicket` / `verifyTicket` primitive in
  `lib/auth/ws-ticket.ts` with `CRYSTAL_FORGE_WS_SECRET` (or a dedicated shared secret).
- Apps key authorization on the **stable `oid`**, not email (emails can change). What an app
  does with the identity (hardcoded allowlist, its own roles table, config) is the app's
  business; the gate never needs to know.
- An interim alternative, if identity is needed before containers land, is **shared-session
  SSO**: configure the forge template's Auth.js with the same `AUTH_SECRET` and cookie name as
  the dashboard so the same-origin session cookie is read directly. The forwarded-header path
  is preferred long-term because it keeps forge apps stateless and secret-free.

Forward-compatibility requirements imposed on the current design (both already satisfied):

1. The proxy is the **single auth chokepoint** — the only place a forwarded identity header
   could later be injected.
2. Identity flows by session/gate, **never** by per-app Entra. Clones keep receiving empty
   Entra credentials.

## Testing

- **Unit (Vitest, colocated):**
  - basePath patch in `clone.ts`: fresh clone gets wrapped config + `next.config.base.ts`;
    re-running is idempotent (no double-wrap); non-object default export is skipped.
  - Proxy route: `401` without session; `404` for unknown/stopped slug; `404` when ACL denies;
    on success forwards method/path/query/headers (minus hop-by-hop) to `runtimeOrigin` and
    streams the upstream response back. Use a fake upstream + injected `loadState`/ACL deps.
  - `runtimeOrigin(slug)` returns `http://127.0.0.1:<port>` for a running entry.
- **Manual / pilot verification:** with `bmodi-test1` running, load
  `https://forge-pilot.crystalfountains.com/app/bmodi-test1/` from a remote browser — the forge
  app renders with assets and navigation working under the prefix; the dashboard iframe and
  "Open"/"standalone" links resolve to the path; an unauthorized user gets a 404.

## Affected files

- `lib/runtime/clone.ts` — basePath-injection step (+ tests).
- `lib/services/runtime.ts` — `FORGE_BASE_PATH` spawn env.
- `app/app/[slug]/[[...path]]/route.ts` — new reverse-proxy route (+ tests).
- `lib/runtime/` — small `runtimeOrigin()` helper (location TBD in plan; near `state.ts`/
  `ports.ts`).
- `app/(app)/forges/[id]/InstancePanel.tsx` — path-based preview URL.
- `app/(app)/dashboard/ForgeCardRuntime.tsx` — path-based "Open" URL.
- Already-cloned `bmodi-test1` is fixed automatically on its next start (idempotent patch).
