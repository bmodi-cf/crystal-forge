# Launch Dashboard — Design

**Date:** 2026-07-06
**Status:** Approved

## Purpose

A launcher portal at `/launch` that shows only the **running** forges the signed-in user
can access, as large bold cards. Clicking a card opens that forge's live application
(`/app/{slug}/`) in a new window. It is a read-only surface for *using* forges, in
contrast to `/dashboard`, which is for *managing* them.

## Scope

- New page `/launch` in the `(app)` route group (inherits authenticated layout + topbar).
- The topbar currently has no inline nav links (navigation lives in the `UserMenu`
  dropdown). Add a visible inline "Launch" link in `Topbar.tsx`, between the brand block
  and the user menu — a launcher portal should not be buried in a dropdown.
- Cards show, for now: tone-colored initials block, forge name (large, bold), and the
  small group-tag pills. Hero images come later; the layout reserves the upper card area
  for them (name + tags sit along the lower edge).
- No management controls of any kind on this page (no edit/delete/start/stop/promotion).

Out of scope: hero images, per-user landing-page redirects, any new API or schema.

## Access control

Identical to the rest of the app — no new rules:

- Server: `listForges(session.user)` applies `forgeReadFilter` (groups + creator +
  admin bypass).
- Runtime status: `/api/forges/runtime` is already ACL-filtered server-side.
- Unauthenticated requests redirect to `/login`, same as `/dashboard`.

## Architecture & data flow

```
app/(app)/launch/page.tsx        server component: auth() → listForges(user) → <LaunchClient>
app/(app)/launch/LaunchClient.tsx client: useForgeRuntimes() 3s poll; filter to status === 'running'
app/(app)/launch/LaunchCard.tsx   presentational card; whole card is one <a target="_blank">
```

- `LaunchClient` renders a `LaunchCard` only for forges where
  `runtimes[forge.id]?.status === 'running'`. All other states (absent, starting,
  stopping, crashed, setup-failed) mean the card is simply not shown.
- Cards appear/disappear live as forges start/stop, courtesy of the existing
  `useForgeRuntimes` 3-second poll. No page refresh needed.
- `LaunchCard` is a separate component from `ForgeCard` — they share almost nothing.
- Click target: `<a href={`/app/${runtime.slug}/`} target="_blank" rel="noopener noreferrer">`
  wrapping the entire card.

## UI

- Responsive grid, roughly 2–3 cards per row on desktop; cards are large
  (min-height ≈ 200px) with bold typography.
- Card content: initials block using the tone treatment currently defined as
  `TONE_CLASSES` in `ForgeCard.tsx` — extract it to a shared module (e.g.
  `components/forge-tone.ts`) so both cards import it rather than duplicating the
  gradients. Forge name in large bold type; group pills matching the dashboard's tag
  styling.
- Empty state: centered "No forges are running right now" with a link to `/dashboard`.

## Error handling

Nothing new. Poll failures keep last known state (existing `useForgeRuntimes`
behavior); the page is read-only so there are no mutations to fail.

## Testing

- `LaunchCard.test.tsx`: renders name and group tags; anchor points at `/app/{slug}/`
  with `target="_blank"` and `rel="noopener noreferrer"`.
- `LaunchClient.test.tsx`: only running forges render; card set updates when the
  runtime map changes; empty state renders when nothing is running.
- Manual verification in dev with `GITHUB_CLIENT_MODE=fake`.
