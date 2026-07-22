# Work Order Print Tool — splash / inherited-login page

**Date:** 2026-07-22
**Status:** Design approved
**Target repo:** `CrystalFountainsInc/Work-order-drawing-printing-tool-` (edits in the live
workspace volume `forge-work-order-drawing-printing-tool`, **uncommitted** — same as the
prior forge-compat edits, see memory `non-template-repo-as-forge`).

## Goal

The Work Order Print Tool was not created from `crystal-forge-template-webapp`, so it lacks
the template's landing/splash page and does not consume the dashboard-injected identity.
Port that pattern into its plain-Node `server.js` + Babel-SPA architecture:

1. A splash page at the forge root (Crystal logo, welcome, "Login to Continue").
2. Consume the inherited Entra identity from the trusted `x-forge-user` header.

This task is **presentation only**. It is NOT an auth boundary — the `x-forge-user` header
is trusted-but-unsigned (see memory `forge-user-header-unsigned`); real hardening is tracked
separately. A gate inside the forge app cannot add security because that header is its only
identity signal.

## Background (verified)

- The dashboard authenticates via Entra, ACL-gates, then reverse-proxies `/app/<slug>/…` to
  the forge, injecting `x-forge-user` = base64url(JSON `{id,email,name,groups,isAdmin}`).
  Forge apps have no identity of their own (`lib/runtime/preview-proxy.ts`).
- Every dashboard open-forge link points at the forge **root** `/app/<slug>/`
  (`LaunchCard.tsx:17`, `ForgeCardRuntime.tsx:92`, `InstancePanel.tsx:27`) — nothing
  deep-links past it, so a splash at `/` is what loads on open.
- `server.js` already strips `FORGE_BASE_PATH` from inbound paths and injects a
  `<base href="/app/<slug>/">` + `fetch()` shim into served HTML (`injectForgeBasePath`).
- Template pattern: `app/page.tsx` = splash (logo + "Welcome to <name>" + gold "Login to
  Continue" → `/home`); `app/home/page.tsx` = the app, reads the header via `getForgeUser`.
- Brand colors: `cf-dark-blue #001C38`, `cf-navy #002E5C`, `cf-dark-blue-75 #40556A`,
  `cf-gold #B9A060`, `cf-gold-75 #CBB888`.

## Changes

All in the workspace volume. No changes to the 84 KB `app.jsx` or any existing asset.

### 1. Routing (`server.js` → `resolveStaticFile`)

Today: `/` → `Work Order Print Tool.html`. New:

- `/`     → `welcome.html` (new splash)
- `/home` → `Work Order Print Tool.html` (existing SPA, unchanged)

```js
let requested = decoded;
if (decoded === "/") requested = "/welcome.html";
else if (decoded === "/home") requested = "/Work Order Print Tool.html";
```

The SPA loads its scripts/styles via **relative** URLs, and the injected `<base>` fixes
resolution regardless of path depth, so serving it from `/home` needs no SPA changes.

### 2. Allowlist + MIME (`server.js`)

- `STATIC_FILE_ALLOWLIST`: add `"/welcome.html"`.
- `MIME_TYPES`: add `".png": "image/png"` (currently absent → logo would serve as
  `application/octet-stream`).

### 3. Splash page (`public/welcome.html`) — new, self-contained

- `background #001C38`, full-screen centered column, Montserrat (Google Fonts; the forge
  network allows outbound HTTPS).
- White Crystal logo `<img src="crystal-logo-white.png">` (relative → resolves under base).
- Gold divider + `Welcome to ` **`Work Order Print Tool`**.
- Gold "Login to Continue" button: `<a href="home">` (relative → base + `home` =
  `/app/<slug>/home`; works standalone too where base = `/`).

`injectForgeBasePath()` runs on it automatically (it's `.html`) so base-path resolution is
correct in-forge and a no-op standalone.

### 4. Logo asset

Copy `crystal-logo-white.png` from `crystal-forge-template-webapp/public/` into the forge's
`public/` (via `docker cp` into the volume).

### 5. Inherited identity (`server.js`)

- **`decodeForgeUser(req)`** — mirror the template's `getForgeUser`: read
  `req.headers["x-forge-user"]`, base64url→JSON, validate `id`/`email` are strings, return
  `{id,email,name,groups,isAdmin}` or `null`.
- **`GET /api/forge-user`** (new route, before the static catch-all) →
  `sendJson(res, decodeForgeUser(req))` (returns `null` standalone).
- **`/home` injection:** extend `serveStatic(pathname, res)` → `serveStatic(pathname, res, req)`
  (single call site, the catch-all at ~line 525). When the resolved file is
  `Work Order Print Tool.html` and a user is present, inject before `</body>`:
  - `<script>window.__FORGE_USER__ = {…}</script>` (alongside the existing `__FORGE_BASE__`).
  - A subtle fixed top-right chip: `Signed in as <gold>{name}</gold>`, inline-styled
    (dark-blue bg, `#40556A` border), **name HTML-escaped** to prevent injection. Shown only
    when a user is present. No `app.jsx` changes.

## Out of scope (this task)

- `splash-logo.png` for the Launch-card thumbnail — skipped for now (card stays title-only).
- Signing / network-isolation of `x-forge-user` — tracked in memory `forge-user-header-unsigned`.
- Committing/pushing to GitHub — edits stay in the volume, uncommitted.

## Verification

`server.js` has no unit harness, so verify by exercising the running forge:

1. `restart-app.sh` in the container.
2. Through the dashboard proxy (authenticated):
   - `GET /app/<slug>/` → splash HTML (logo, welcome, button); assets/CSS render.
   - "Login to Continue" → `/app/<slug>/home` → SPA loads; identity chip shows the signed-in
     user; CSS/JS intact.
   - `GET /app/<slug>/api/forge-user` → JSON of the signed-in user.
   - `GET /app/<slug>/crystal-logo-white.png` → 200 `image/png`.
3. Standalone sanity (no header): `/home` serves the SPA with no chip; `/api/forge-user` →
   `null`.
```
