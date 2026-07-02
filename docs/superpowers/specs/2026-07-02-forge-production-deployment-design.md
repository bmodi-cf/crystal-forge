# Crystal Forge — Production Deployment / Promote-to-Prod Design

- **Date:** 2026-07-02
- **Status:** Draft — awaiting user review
- **Author:** Bhadresh Modi (with Claude Code assistance)
- **Slice:** Introduce a promotion path that takes what a team built in a Forge (currently
  dev-only on the PILOT machine) and deploys it as a running production application on a
  separate prod server. Covers packaging, distribution, gating, permissions, state, and DB
  migration.

## 0. Scope boundary

This slice covers the promotion path **up to and including pushing a production image to the
on-prem registry.** Everything past the registry — pulling the image to prod, running it,
provisioning the prod database, running migrations against prod, prod ingress/networking — is
**explicitly deferred to a later phase.** DB migration is addressed here only insofar as
migrations must be *packaged into the image* so the future deploy phase can apply them.

## 1. Context

Today every Forge runs only in **dev mode** on the pilot machine: a Docker container running
`pnpm dev` with HMR tunneled through the dashboard and Claude Code inside, each pointing at
its own database inside the shared `crystal-forge-pg` Postgres. There is no way to take a
Forge's app to production.

This phase adds that path. Both pilot and prod are **on-prem, VPN-accessed, internal-only
servers** with server-to-server reachability but no exposure to the public internet.

## 2. Settled decisions (infrastructure & packaging)

### 2.1 Production target — separate prod server/VM
Promoted apps run on a **distinct prod host**, not the pilot box. The dashboard (on pilot)
pushes packages to it. Clean dev/prod isolation; both self-manage Docker.

### 2.2 Package unit — immutable Docker image at a pinned commit
The "package" is a **production Docker image** built from the Forge repo at a pinned git
commit and tagged with a version. The pilot builds the image once; prod runs that exact,
byte-identical artifact.
- Rationale: the Forge already runs as a container in dev, so this is the smallest leap and
  preserves dev/prod parity. Rollback = repoint prod at a prior tag; no rebuild.
- Requires a **production Dockerfile** in the template (real `next build` / production start,
  not `pnpm dev`). This is new template work in scope for the phase.
- Air-gapped fallback (not needed here, recorded for completeness): `docker save | ssh |
  docker load` if a registry were ever unreachable.

### 2.3 Distribution — on-prem container registry on the pilot
Because both boxes are internal and reach each other over the VPN, the registry **lives on
our network** — no egress, no quotas, images never leave our infrastructure. (GHCR's free
tier — ~500 MB storage / ~1 GB monthly egress for private packages — is too small and the
wrong shape for repeated on-prem pulls.)
- **Start with `registry:2`** on the pilot (one `docker run`, tiny, free).
- **Graduate to Harbor** when we want a web UI, human RBAC, and image vulnerability scanning.
  The machine push/pull path does not change when we switch.

### 2.4 Registry security — TLS via existing wildcard cert + service-account auth
- The registry is served over **HTTPS** using the existing `*.crystalfountains.com` wildcard
  cert (already in `certs/`). Plain-HTTP registry auth is unsafe (basic-auth creds in the
  clear) and Docker refuses credentialed HTTP anyway; the VPN is **not** a substitute for
  registry TLS.
- Machine-to-machine auth uses a **service account**, never a human identity:
  - `registry:2`: htpasswd service users (pilot = push, prod = pull-only).
  - Harbor (later): **robot accounts**, project-scoped push/pull, independent of the UI auth
    mode.
- Harbor human/UI login (later) can federate to **Entra ID via OIDC** (issuer
  `https://login.microsoftonline.com/<tenant>/v2.0`, its own app registration, redirect
  `https://<harbor-host>/c/oidc/callback`, scopes `openid profile email offline_access`).
  Entra/OIDC is for people; robot accounts are for the pipeline.

### 2.5 Single-server topology (pilot hosts both)
Crystal Forge and the registry both run on the **one pilot server**. They are separated by:
- **Recommended:** distinct hostnames behind one reverse proxy on 443 doing name-based
  routing (`forge.crystalfountains.com` → dashboard, `registry.crystalfountains.com` →
  registry). One TLS termination point using the wildcard cert. A registry needs the root of
  a hostname, so a **subdomain** (not a path) is the right separator.
- **Simpler alternative:** same host, distinct ports (dashboard `:3030`, registry `:5000`),
  no proxy.
- External dependency either way: **one DNS record** (`registry.crystalfountains.com` → pilot
  internal IP), or a wildcard DNS record, or an `/etc/hosts` entry on prod for a quick start.
  Note: a wildcard *cert* is not wildcard *DNS* — the name must still resolve.

## 3. Gating

### 3.1 Branching model — `main` = production, `dev` = work
Teams iterate on `dev` (where Claude Code runs). Promotion is fundamentally **merge
`dev` → `main`, then deploy `main`**. `main` always reflects what is in / going to prod. The
merge is the natural gate point.

### 3.2 Promotion flow — dev requests, admin approves
Two actors, a request/approval workflow:
1. Dev works in the Forge + Claude workspace; commits and pushes to **`dev`**. Repeat until
   happy.
2. Dev clicks **"Request to Production"** in the dashboard → dashboard (via the GitHub App)
   **opens a PR `dev → main`** and **triggers the self-hosted runner** to run the gates.
3. The runner reports gate results back as PR status checks; the dashboard surfaces them on
   the Promotion Request.
4. **Admin** opens the dashboard, sees **all pending requests to PROD** with their **gate
   results + summary**.
5. Admin clicks **Accept** or **Reject**:
   - **Reject** → close the PR, mark the request rejected (optional reason).
   - **Accept** → **merge `dev → main`**, build the production image, **push it to the on-prem
     registry.** (Pull/deploy to prod is out of scope — see §0.)

Branch protection on `main` backstops the merge (checks must be green), but the **admin's
Accept is the authoritative human gate.**

### 3.3 Gate criteria
Mandatory:
1. **Production build succeeds** (`next build` + image build). Can't ship an artifact that
   doesn't build. Runs during the pre-approval gates so the admin sees its result (§3.6).
2. **Typecheck + lint pass** (`tsc --noEmit`, ESLint) — status check on the PR.
3. **Automated tests pass *if present*** (Vitest/Playwright). Skipped gracefully for Forges
   with no tests so it never blocks a team that hasn't written any.
4. **Human approval by the admin** — the admin's **Accept** on the pending request (§4.2).

Future gate:
5. **GitHub AI analysis report on the merge must pass** — a required status check produced by
   an AI review of the PR. Designed for now as an additional required check on `main`;
   wired in when available.

### 3.4 Where checks run — self-hosted GitHub Actions runner on the pilot
Automated checks (and later the AI report, and the production image build + push) run on a
**self-hosted Actions runner on the pilot**. On-prem, no Actions-minutes cost, everything
stays internal, and the same runner can build+push the production image to the on-prem
registry.

### 3.5 Build timing — during pre-approval gates
The production image is built by the runner **as part of the checks triggered on "Request to
Production"**, so the admin sees `build: green` alongside tests/lint before deciding. To keep
the verified image identical to what ships on `main`:
- Branch protection requires the PR be **up-to-date with `main` before merge**, so the
  `dev` head's tree equals the post-merge `main` tree.
- The build produces an image tagged by **commit SHA** (candidate tag). On **Accept**, the
  dashboard merges `dev → main` and applies the **release tag** to that same verified image
  (retag, no rebuild). See §5 for the tagging scheme.

### 3.6 New work implied
- Add a **CI workflow** to the template (typecheck, lint, conditional tests) so every Forge
  repo inherits it.
- The GitHub App **configures branch protection on `main`** at provisioning time, requiring
  the status checks above.
- Provision/register the **self-hosted runner** on the pilot.

## 4. Permissions

### 4.1 Two roles — Dev requests, Admin approves
- **Requester (Dev):** any user with **write** access to the Forge (admin or the Forge's
  creator, per the existing `canWriteForge`) may click **Request to Production**. This opens
  the PR and triggers the gates. It does **not** merge or push anything.
- **Approver (Admin):** only dashboard **admins** (`user.isAdmin`) may **Accept/Reject** a
  pending request. Accept is what merges `dev → main` and builds+pushes the image.

Separation of duties falls out naturally: the person who builds the app requests promotion;
a different (admin) role authorizes it. No new role concept is needed — it maps onto the
existing write-vs-admin distinction.

### 4.2 The Admin's Accept is the human-approval gate
Accept is gate 3.3(4). On Accept the dashboard (via the GitHub App) confirms required status
checks are green, merges `dev → main`, then builds + pushes the image (§ build mechanism).
Reject closes the PR and records the request as rejected.

### 4.3 Machine credentials (recap from §2.4)
Human identity is never used for the pipeline. Push/pull use a registry service account
(htpasswd for `registry:2`, robot accounts for Harbor later); the self-hosted runner uses its
own registration token; prod deploy uses a dedicated, least-privilege credential (see §7).

## 5. Build & push mechanism

### 5.1 Production Dockerfile in the template
The template gains a production **Dockerfile** (multi-stage: install → `next build` →
slim runtime image running the production server, not `pnpm dev`). Every Forge repo inherits
it. The image bundles the built app **and the committed `prisma/migrations/`** (see §7). It
does **not** run migrations at build time.

### 5.2 Tagging scheme
- **Candidate tag (on request):** `registry.crystalfountains.com/<forge-slug>:sha-<gitsha>`
  — immutable, traceable to the exact commit, built and pushed during the pre-approval gates.
- **Release tag (on Accept):** the same image additionally tagged
  `:<version>` where version is a monotonic promotion counter per Forge (e.g. `v1`, `v2`, …)
  plus a moving `:latest`. Rollback later = point prod at a prior `:vN` (future phase).
- Retag on Accept is a registry manifest operation — no rebuild.

### 5.3 Push credential
The runner pushes with the registry **push service account** (§2.4) over TLS. No human
identity, no interactive login.

### 5.4 Where the mechanism runs
All of build, candidate-push, and retag-on-accept run on the **self-hosted runner on the
pilot**, driven by GitHub Actions workflows the dashboard triggers and by GitHub App calls
the dashboard makes (merge, tag). Scope ends when the release-tagged image is in the
registry.

## 6. Promotion Request — data model & UI

### 6.1 Entity
A first-class **PromotionRequest** persisted by the dashboard:
- `id`, `forgeId`, `requestedById`, `createdAt`
- `prNumber` / `prUrl`, `headSha`
- `status`: `pending` | `checks_running` | `checks_failed` | `awaiting_approval` |
  `accepted` | `rejected`
- `gateResults`: per-gate status (build, typecheck, lint, tests, ai_report) + links to logs
- `summary`: human-readable summary of the change (see 6.3)
- `approvedById` / `decidedAt` / `rejectReason` (nullable)
- `imageRef`: the candidate image ref once built; release ref once accepted

### 6.2 Views
- **Dev view:** on a Forge, a **Request to Production** button (enabled for writers); shows
  the status of any in-flight request and gate progress.
- **Admin view:** a **Pending Promotions** queue listing all requests across Forges with gate
  results + summary, and **Accept / Reject** actions.

### 6.3 Summary content
The summary the admin reviews includes: Forge name, requester, commit range `main…dev`
(commits + changed-file stats), gate results at a glance, and a link to the PR. The future
**AI analysis report** slots in here as an additional summary panel + required gate.

## 7. State, data & DB migration (mostly deferred — see §0)

### 7.1 In scope now: migrations travel in the image
Prisma migrations are committed in each Forge repo (`prisma/migrations/`) and **copied into
the production image**. The image's runtime contract (documented, not executed here) is that
on startup in the future deploy phase it will run `prisma migrate deploy` against the prod
`DATABASE_URL`. This slice only guarantees the migrations are present in the artifact and the
image builds with them.

### 7.2 Deferred to the deploy phase
- Provisioning the **prod database** (topology TBD: shared prod Postgres with a DB per Forge,
  mirroring dev, vs. a dedicated Postgres per Forge). **Do not decide here.**
- Running migrations against prod; migration failure/rollback handling.
- Prod persistent volumes for any non-DB state.
- Injecting prod `DATABASE_URL` / secrets at run time.
- Prod ingress, TLS, and how prod pulls the image from the registry.

## 8. Components & new work (summary)

- **Template:** production `Dockerfile`; CI workflow (typecheck, lint, conditional tests).
- **GitHub App:** at provisioning — create `dev` branch, set `main` as default-protected,
  configure branch protection (required checks + up-to-date-before-merge). At request time —
  open PR; at accept — merge + tag.
- **Dashboard:** `PromotionRequest` model + service; Dev "Request to Production" action;
  Admin "Pending Promotions" queue with Accept/Reject; wiring to trigger the runner and read
  gate results.
- **Infra (pilot):** on-prem `registry:2` behind the reverse proxy with wildcard-cert TLS;
  self-hosted GitHub Actions runner; registry push/pull service accounts; DNS record for
  `registry.crystalfountains.com`.

## 9. Open questions

- **Tests-if-present detection:** how the CI decides a Forge "has tests" (presence of
  `*.test.ts(x)` / a `test` script that isn't a no-op). Needs a concrete rule.
- **Version counter source:** where the monotonic per-Forge promotion version lives (likely
  derived from accepted `PromotionRequest` count).
- **Runner concurrency:** one self-hosted runner vs. a small pool if multiple Forges request
  at once; job isolation between Forges on a shared runner.
- **AI analysis report:** provider/mechanism for the future required check (GitHub-native AI
  review vs. a custom action calling the Claude API).
- **Candidate image retention:** garbage-collection policy for `sha-*` candidate tags whose
  requests were rejected.
