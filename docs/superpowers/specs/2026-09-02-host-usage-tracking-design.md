# Host usage tracking — design

**Date:** 2026-09-02
**Status:** approved, awaiting implementation plan

## Purpose

Answer capacity questions about the host a dashboard runs on: is the VM outgrown,
is the disk filling, and how does that change as forges are added. One job only —
retained history at coarse granularity, read on an admin page.

Explicitly **not** in scope, all declined during design:

- Live "why is it slow right now" diagnosis (no streaming, no auto-refresh).
- Per-forge attribution of CPU or memory (host totals only).
- Alerting or thresholds that block a forge start.
- Post-mortem-grade resolution of a single spike.

## Measured facts about the pilot host

Gathered 2026-09-02 on the host itself; the design leans on these, so re-check
them before assuming any of it transfers to another machine.

| Fact | Value | Consequence |
|---|---|---|
| CPUs | 1 | Sampling overhead is not free; see the docker cadence below. |
| Memory | `MemTotal 16373060 kB`, `MemAvailable 6505424 kB` | `free` reports 9.6 G "used" but 6.4 G available; available is the honest capacity number. |
| Root fs | `/dev/sda2`, 250 G, 51 % used, single filesystem | One disk series suffices. `statfs('/')` gives `blocks 65506593`, `bfree 33875802`, `bavail 30530049`. |
| `docker system df` | **~17 s** (17.7 s CLI, 16.7 s socket; client CPU 0.02 s) | The daemon walks 145 images / 32 volumes / 1128 build-cache records. Cannot run every 5 min. |
| Docker usage | images 23.1 GB, volumes 25.5 GB, containers 1.56 GB, **build cache 52.5 GB** | The largest single consumer on the box is a reclaimable cache — the exact thing a trend line surfaces. |
| Node | v24.16.0, `fs.statfs` present | No dependency needed for disk stats. |
| Dashboard process | host systemd unit, not containerized (`deploy/systemd/crystal-forge.service`) | `/proc` and `statfs` read real host numbers. |

## 1. Data model

One wide, flat row per sample. No joins, no rollup table.

```prisma
model HostSample {
  id               Int      @id @default(autoincrement())
  at               DateTime @default(now())

  // /proc/stat line 1: cumulative jiffies. Stored raw; percentages are
  // derived between consecutive rows at read time.
  cpuJiffiesTotal  BigInt
  cpuJiffiesIdle   BigInt
  cpuJiffiesIowait BigInt
  cpuCount         Int

  // /proc/meminfo, bytes
  memTotal         BigInt
  memAvailable     BigInt

  // fs.statfs('/'), bytes
  diskTotal        BigInt
  diskAvailable    BigInt

  // docker daemon /system/df, bytes. Nullable: sampled at a slower cadence
  // than the host metrics, and the call can fail or time out.
  dockerImages     BigInt?
  dockerContainers BigInt?
  dockerVolumes    BigInt?
  dockerBuildCache BigInt?

  runningForges    Int?

  @@index([at])
}
```

Four decisions:

- **Raw cumulative CPU jiffies, not a percentage.** A percentage only exists
  between two reads. Raw counters keep the sampler stateless, let a missed
  sample read as a longer average instead of a phantom spike, and are the only
  way a reboot is detectable at all (the counter decreases).
- **`memAvailable`, not "used".** `MemAvailable` counts reclaimable cache as
  available, which is what answers "is 16 G enough". Used is derived as
  `total - available`, and the page labels it that way so it does not appear to
  contradict `free`.
- **`bavail`, not `bfree`.** The 3.3 M-block difference on this host is
  root-reserved and not available to a build.
- **`BigInt` bytes, converted to `Number` once at the service boundary.** 250 G
  exceeds a 32-bit `Int` but sits far inside `Number`'s safe range, and `BigInt`
  does not survive JSON serialization to a client component.

**Retention:** the sampler deletes rows older than `FORGE_USAGE_RETENTION_DAYS`
(default 90) after each insert. At 5-minute samples that is ~26 k rows
steady-state. No separate job.

## 2. Collection

**Cadence: host metrics every 5 minutes, docker breakdown every 30 minutes.**
`docker system df` costs ~17 s of daemon disk-walking on a
1-vCPU host; running it every 5 minutes would be a 6 % duty cycle of exactly
the kind of self-inflicted IO load that contributed to the 2026-07-28 host
hang. Image, volume and cache growth are slow-moving numbers where half-hourly
resolution is ample. The nullable columns carry the sparser series.

The 30-minute decision is made **from the data, not a tick counter**: a tick
samples docker when the newest row holding non-null docker columns is older than
30 min minus half the sample interval. A counter would reset on every dashboard
restart (which happens on every deploy) and would double up whenever two
samplers interleave, as the guard below allows. A consequence worth stating: the
first tick after a fresh install finds no such row and therefore samples docker
immediately, so the page is populated from the start rather than blank for half
an hour.

**Exact bytes come from the daemon socket, not the CLI.**
`docker system df --format json` hung past 30 s in testing; `--format
'{{json .}}'` returns human strings (`"23.14GB"`); summing `docker image
inspect` double-counts shared layers. `GET /system/df` over
`socketPath: /var/run/docker.sock` returns exact integers that reconcile with
the human output (`LayersSize 23135864692`, volumes `25503138118`, containers
`1560223744`, build cache `52456054966`) — ~15 lines of `node:http`, no new
dependency.

That access belongs behind the existing abstraction: **add `diskUsage()` to
`ContainerManager`** (`lib/runtime/container/types.ts`), implemented in
`docker-container-manager.ts`, with `FakeContainerManager` returning fixed
numbers so the feature works under `FORGE_RUNTIME_MODE=fake`.

**Modules**, kept small and independently testable:

- `lib/host/proc.ts` — pure parsers (`parseCpuLine`, `parseMeminfo`) over
  strings. No I/O. All arithmetic lives here.
- `lib/host/read.ts` — the thin I/O shell: `readFile('/proc/stat')`,
  `readFile('/proc/meminfo')`, `fs.statfs('/')`.
- `lib/host/sampler.ts` — `startUsageSampler(deps, opts) => { stop }`, mirroring
  `startReconcileLoop` (`lib/runtime/prod/reconciler.ts:159`), including its
  in-flight guard.
- `lib/services/usage.ts` — the read path (section 3).

**Home:** `instrumentation.ts` `register()`, before the dev/prod mode split so
both dashboards sample. That function already returns early for
`NEXT_RUNTIME !== 'nodejs'` and `NODE_ENV === 'test'`, so unit tests never
start it.

**Guards:**

- **Duplicate samplers.** `pnpm dev` is `tsx server.ts` — the same entry as
  `pnpm start` — so a dev server and the live service can run against one
  database on this host. Before inserting, the sampler skips if the newest row
  is younger than half the interval. Two samplers then interleave into a single
  clean series rather than doubling it.
- **Partial failure.** Readers are guarded independently. A `/proc` failure logs
  and writes nothing (no half-empty rows). A docker failure or 30 s timeout
  leaves the four docker columns `NULL` and still records the host numbers.
- **Retention** runs after each insert, as above.

**Elsewhere:**

- `lib/env.ts` gains `FORGE_USAGE_SAMPLE_MS` (default `300000`; `0` disables the
  sampler) and `FORGE_USAGE_RETENTION_DAYS` (default `90`), following
  `FORGE_RECONCILE_INTERVAL_MS`.
- `ContainerManager.list()` runs `docker ps -a`
  (`docker-container-manager.ts:181`) and so counts stopped containers — and
  crashed forges do linger, since a probe timeout deliberately keeps the
  container. `list(opts)` gains an optional `running?: boolean` that appends
  `--filter status=running`, for an honest `runningForges`. That call is a plain
  `docker ps` (sub-second), so it runs on every tick; if it fails,
  `runningForges` is `NULL` for that row and the host metrics are still written.

## 3. Read path and aggregation

Follows the established admin pattern with no invention: thin `page.tsx` server
component → client component → `fetch('/api/admin/usage?range=7d')` → route
handler doing `auth()`, service call, `respondToServiceError`, mirroring
`app/api/admin/groups/route.ts`. The service gate is the usual
`if (!user.isAdmin) throw new ForbiddenError('Admin only')`
(`lib/services/users.ts:84`); `range` is zod-validated against the four values
below.

**Aggregate in JS, not SQL.** `lib/services/usage.ts` runs one `findMany` over
the range and hands the rows to a pure `lib/host/series.ts`. The arithmetic has
three sharp edges — counter deltas, reboots, gaps — and they belong in vitest
fixtures, not a `$queryRaw` window function. The cost is bounded: 90 days at
5-minute samples is ~26 k rows of a dozen numeric columns over a loopback
connection, on an occasionally-opened admin page. **If retention ever grows past
roughly a year (~105 k rows), revisit and push bucketing into Postgres.**

Fixed buckets per range, targeting ~180–290 points (~30 KB of JSON):

| Range | Bucket | Points |
|---|---|---|
| 24 h | raw (5 min) | 288 |
| 7 d | 1 h | 168 |
| 30 d | 4 h | 180 |
| 90 d | 12 h | 180 |

Deriving the series:

- **CPU %** per interval is `1 - Δidle / Δtotal`. The `/proc/stat` aggregate line
  already sums all cores, so this is average utilization across the box and is
  *not* divided by `cpuCount`; that column exists for the "1 vCPU" label and for
  a future resize. Iowait counts as busy in that figure, and is additionally
  plotted as its own band — on a 1-vCPU host whose heaviest workload walks disk,
  compute-bound versus IO-bound is a real capacity distinction.
- **Mean and peak.** Per-interval deltas are already computed, so each bucket
  carries both a mean and a max for CPU and memory. Peak memory over 90 days is
  the number that answers "is 16 G enough"; a 12-hour mean smooths away the
  event that matters.
- **Gaps break the line.** Consecutive rows more than 3× the sample interval
  apart emit `null`, not an interpolated value, so a deploy window or outage
  reads as a gap. Recharts leaves nulls as breaks by default.
- **Reboots emit `null`.** A decreasing counter means the host rebooted; that
  interval's CPU is unknowable.
- **Docker columns bucket separately** at `max(bucketMs, 30 min)`, last value per
  bucket, over non-null rows only — drawing them on the 5-minute axis would be
  mostly holes.
- `BigInt` → `Number` conversion happens here, once.

`series.ts` stays pure by taking the expected sample interval as a parameter —
the service passes `FORGE_USAGE_SAMPLE_MS` in, since the gap threshold above is
defined relative to it and the value is configurable.

## 4. The page

`{ href: '/admin/usage', label: 'Usage' }` appended to `BASE_ITEMS` in
`AdminNav.tsx` — that array is mode-independent, so the page appears in both the
pilot and prod dashboards without touching the `PROMOTIONS`/`DEPLOYMENTS` split.
`app/(app)/admin/usage/page.tsx` is a thin `force-dynamic` server component with
no `notFound()` mode gate, rendering `UsageClient.tsx`.

One column:

1. **Range switcher** — 24 h / 7 d / 30 d / 90 d, defaulting to 30 d.
2. **Four "right now" tiles** from the latest row: CPU %, memory used / total,
   disk used / total, running forges.
3. **Four stacked charts on a shared time axis** — CPU (mean area, peak line,
   iowait band); memory used (area + peak line, total as a reference line so
   headroom is visible); disk used against capacity; docker breakdown as a
   stacked area (images / volumes / build cache / containers).

**No auto-refresh.** Fetch on mount and on range change, plus a manual refresh
button. Live diagnosis is out of scope, the data is 5-minute granular, and
polling would be load for no information.

**Empty and thin states will be seen first.** Zero rows renders "Collecting —
first samples appear within 5 minutes", not an empty axis. A range wider than
the retained history draws what exists rather than padding. Loading and error
states follow `PromotionsClient`'s conventions.

**Units: GiB (base-1024)** everywhere, matching `df -h` and `free -m` — the two
commands used to cross-check. The consequence, which the page labels explicitly
to keep it from reading as a bug: docker figures render *lower* than
`docker system df`'s own base-1000 formatting (build cache 52.46 GB there,
48.9 GiB here). The stored bytes are exact and identical; only the formatting
differs.

**Theming:** Recharts takes colors as props, not classes, so chart colors are
read from the existing token CSS variables (`--panel`, `--ink-dim`, …) rather
than hardcoded, keeping light/dark working.

**Charting library:** Recharts 3.10.1, which lists React 19 in its peer
dependencies. Accepted costs: a client island of roughly 100 kB gz on that route,
a dozen-odd transitive d3 packages, a few seconds on a build that blocks the
service on every restart, and colors threaded as props. Bought: tooltips, axis
ticks, responsive resize, stacked areas and gap handling — most of which matter
for reading a value off a 90-day chart. Chart *form* and palette are settled at
implementation time under the `dataviz` skill; this spec pins only the structure.

## 5. Testing

Unit (vitest, colocated):

- `lib/host/proc.test.ts` — parsers against fixtures captured verbatim from this
  host, plus malformed input and a missing `MemAvailable`.
- `lib/host/series.test.ts` — the substance: delta arithmetic; a counter decrease
  yielding `null` (reboot); a gap over 3× interval yielding `null`; mean vs peak
  per bucket; sparse docker bucketing; empty input; and a single row yielding
  zero points, not a zero.
- `lib/host/sampler.test.ts` — injected deps and clock: writes a row; skips when
  the newest row is younger than half the interval; samples docker only once the
  newest docker-bearing row has aged past 30 min, and on the very first tick;
  docker failure or timeout leaves those columns `null` but still writes the row;
  `/proc` failure writes nothing; retention deletes with the right cutoff;
  in-flight guard holds; `stop()` clears the interval.
- `lib/services/usage.test.ts` — non-admin gets `ForbiddenError`, admin gets the
  series, bad `range` rejected.
- `docker-container-manager.test.ts` / `fake-container-manager.test.ts` —
  `diskUsage()` parsing a trimmed real `/system/df` payload, asserting exact
  integers; `list({ running: true })` appending `--filter status=running`.
- `AdminNav.test.tsx` — the new item, in both modes.
- `UsageClient.test.tsx` — **smoke only**, Recharts stubbed: tiles render from a
  fixture series, empty state shows, a range change refetches. No assertions on
  chart internals — jsdom has no layout, so `ResponsiveContainer` renders
  nothing, and everything worth testing lives in `series.ts`.

`vitest.global-setup.ts` already runs `prisma migrate deploy` against the `_test`
database, so the new table arrives with no harness changes.

e2e (Playwright): the sampler would otherwise run for real under e2e
(`instrumentation.ts` only skips `NODE_ENV === 'test'`), and waiting 5 minutes
for a first sample is not a test. `scripts/e2e.sh` gains
`FORGE_USAGE_SAMPLE_MS=0` plus `FORGE_SEED_USAGE=1`, the latter making
`prisma/seed.ts` generate ~48 h of synthetic `HostSample` rows. Gating on that
env var deliberately keeps synthetic rows out of the pilot's dev database — this
working tree *is* the live pilot, and a populated-looking chart made of fake
history is worse than an empty one. `tests/e2e/usage.spec.ts` asserts an admin
sees the nav item and a populated page, and a non-admin does not.

## Rollout

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `./scripts/e2e.sh`. Then, because
this repo is the live pilot: `pnpm db:migrate`, restart `crystal-forge.service`,
and confirm a real row lands within 5 minutes and the page draws it.

## Deferred

Not built, and each would be a fresh design conversation:

- Per-forge CPU/memory attribution (needs a `stats` capability and N× rows).
- Alerting or a forge-start block on low disk.
- Two-tier retention (raw + permanent hourly rollups).
- SQL-side bucketing, warranted past ~105 k rows.
