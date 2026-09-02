# Host Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a `/admin/usage` page charting this host's CPU, memory, disk and docker disk consumption over 24 h / 7 d / 30 d / 90 d, fed by a 5-minute in-app sampler.

**Architecture:** A sampler started from `instrumentation.ts` reads `/proc/stat`, `/proc/meminfo` and `statfs('/')` every 5 minutes and writes one wide `HostSample` row, storing **raw cumulative CPU jiffies** rather than percentages. Docker's disk breakdown is sampled only every 30 minutes because `docker system df` costs ~17 s on this host. All derivation — jiffy deltas, bucketing, reboot and gap detection — happens at read time in a pure module, so it is unit-testable without a database or a browser.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 7 + Postgres 16, Vitest (jsdom by default; `// @vitest-environment node` for DB tests), Playwright, Recharts 3.10.1 (new dependency).

**Spec:** `docs/superpowers/specs/2026-09-02-host-usage-tracking-design.md` — read it alongside this plan; the measured host facts it records are the reason for several non-obvious choices below.

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing App Router code.** This is Next 16; APIs differ from training data (see `AGENTS.md`).
- **Sample interval:** 5 min (`FORGE_USAGE_SAMPLE_MS`, default `300000`; `0` disables the sampler). **Retention:** 90 days (`FORGE_USAGE_RETENTION_DAYS`, default `90`). **Docker sub-cadence:** 30 min (`DOCKER_SAMPLE_INTERVAL_MS = 1_800_000`, a code constant, not env).
- **Docker access only through `ContainerManager`.** Never call `docker` or its socket from a service or a route.
- **Byte columns are Prisma `BigInt`**, converted to `Number` exactly once, in `lib/host/series.ts`. `BigInt` does not survive `JSON.stringify`.
- **Memory "used" is `memTotal - memAvailable`**, and must be labelled as such in the UI. It will not match `free`'s "used" column, deliberately.
- **Disk free is `bavail`, never `bfree`.**
- **Units are GiB (base-1024) everywhere**, labelled `GiB`, including the docker figures — which will therefore read lower than `docker system df`'s base-1000 output (52.46 GB → 48.9 GiB). Same exact bytes, different formatting.
- **Tests are colocated** as `*.test.ts(x)` next to the source. Playwright specs live in `tests/e2e/`.
- **Never run `pnpm db:reset`, `./forge-launch.sh --seed`, or `pnpm db:seed` against the dev database** — this working tree is the live pilot. `pnpm test` deriving a `_test` database and printing `🌱 The seed command has been executed` is expected and safe.
- **Run `./scripts/e2e.sh`, never `pnpm exec playwright test`.**
- Commit after every task. Branch is `dev`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `lib/host/proc.ts` | Pure parsers for `/proc/stat` and `/proc/meminfo`. No I/O. |
| `lib/host/read.ts` | Thin I/O shell producing one `HostSnapshot`. Injectable fs. |
| `lib/host/store.ts` | `SampleStore` interface + Prisma adapter. The only DB code. |
| `lib/host/sampler.ts` | The tick: dedupe guard, docker cadence, failure handling, retention. |
| `lib/host/series.ts` | Rows → bucketed `UsageSeries`. All derivation and gap/reboot logic. |
| `lib/host/format.ts` | GiB and percentage formatting. |
| `lib/services/usage.ts` | Admin gate + query + `buildSeries` call. |
| `app/api/admin/usage/route.ts` | `GET /api/admin/usage?range=…`. |
| `app/(app)/admin/usage/page.tsx` | Thin `force-dynamic` server component. |
| `app/(app)/admin/usage/UsageClient.tsx` | Range switcher, tiles, chart layout, empty/error states. |
| `app/(app)/admin/usage/charts.tsx` | Recharts components + colour constants. |
| `tests/e2e/usage.spec.ts` | Admin sees a populated page; non-admin does not. |

**Modified:** `prisma/schema.prisma` (+ generated migration), `lib/test/db.ts` (truncate the new table), `lib/runtime/container/types.ts` (`diskUsage()`, `list({ running })`), `lib/runtime/container/docker-container-manager.ts`, `lib/runtime/container/fake-container-manager.ts`, `lib/runtime/runner.ts` (export `FORGE_LABEL`), `lib/env.ts`, `instrumentation.ts`, `app/(app)/admin/AdminNav.tsx` (+ its test), `prisma/seed.ts`, `scripts/e2e.sh`, `playwright.config.ts`, `package.json` (Recharts), `AGENTS.md`.

---

### Task 1: HostSample table and store adapter

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (via `pnpm db:migrate`, never hand-written)
- Create: `lib/host/store.ts`
- Create: `lib/host/store.test.ts`
- Modify: `lib/test/db.ts:32-43` (add the new table to `withCleanDb`)

**Interfaces:**
- Consumes: nothing.
- Produces: `HostSampleInsert`, `SampleStore` (`latestAt`, `latestDockerAt`, `insert`, `deleteOlderThan`), `prismaSampleStore(prisma)`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Append:

```prisma
/// One host-metrics sample. Wide and flat on purpose: no joins, no rollup table.
/// CPU is stored as RAW CUMULATIVE JIFFIES, not a percentage — a percentage only
/// exists between two reads, and raw counters make a missed sample read as a
/// longer average instead of a phantom spike. They are also the only way a
/// reboot is detectable (the counter decreases).
model HostSample {
  id               Int      @id @default(autoincrement())
  at               DateTime @default(now())

  // /proc/stat line 1. `idle` is field 4; `iowait` is field 5 and is separate.
  cpuJiffiesTotal  BigInt
  cpuJiffiesIdle   BigInt
  cpuJiffiesIowait BigInt
  cpuCount         Int

  // /proc/meminfo, bytes. Used is derived as total - available.
  memTotal         BigInt
  memAvailable     BigInt

  // fs.statfs('/'), bytes. Available is bavail (bfree includes root-reserved).
  diskTotal        BigInt
  diskAvailable    BigInt

  // Docker daemon /system/df, bytes. Nullable: sampled every 30 min rather than
  // every 5 (the call costs ~17 s), and it can fail or time out.
  dockerImages     BigInt?
  dockerContainers BigInt?
  dockerVolumes    BigInt?
  dockerBuildCache BigInt?

  runningForges    Int?

  @@index([at])
}
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:migrate`
When prompted for a name, enter: `host_usage_samples`
Expected: a new directory under `prisma/migrations/`, and the client regenerated so `prisma.hostSample` type-checks. Do not hand-edit the SQL.

- [ ] **Step 3: Write the failing store test**

Create `lib/host/store.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb } from '@/lib/test/db';
import { prismaSampleStore, type HostSampleInsert } from './store';

// Real values measured on the pilot host — large enough to catch any accidental
// 32-bit or float round-trip.
const ROW: HostSampleInsert = {
  cpuJiffiesTotal: 121_752_934n,
  cpuJiffiesIdle: 109_790_958n,
  cpuJiffiesIowait: 906_528n,
  cpuCount: 1,
  memTotal: 16_766_013_440n,
  memAvailable: 6_661_554_176n,
  diskTotal: 268_315_004_928n,
  diskAvailable: 125_051_080_704n,
  dockerImages: 23_135_864_692n,
  dockerContainers: 1_560_223_744n,
  dockerVolumes: 25_503_138_118n,
  dockerBuildCache: 52_456_054_966n,
  runningForges: 3,
};

describe('prismaSampleStore', () => {
  it('round-trips BigInt byte counts with no precision loss', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      await store.insert(ROW);
      const row = await prisma.hostSample.findFirstOrThrow();
      expect(row.dockerBuildCache).toBe(52_456_054_966n);
      expect(row.diskTotal).toBe(268_315_004_928n);
      expect(row.cpuJiffiesIowait).toBe(906_528n);
      expect(row.runningForges).toBe(3);
    });
  });

  it('latestAt returns null on an empty table', async () => {
    await withCleanDb(async (prisma) => {
      expect(await prismaSampleStore(prisma).latestAt()).toBeNull();
    });
  });

  it('latestAt returns the newest row timestamp', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const older = new Date('2026-09-01T10:00:00.000Z');
      const newer = new Date('2026-09-01T10:05:00.000Z');
      await store.insert(ROW, older);
      await store.insert(ROW, newer);
      expect((await store.latestAt())?.toISOString()).toBe(newer.toISOString());
    });
  });

  it('latestDockerAt ignores rows whose docker columns are null', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const withDocker = new Date('2026-09-01T10:00:00.000Z');
      const withoutDocker = new Date('2026-09-01T10:25:00.000Z');
      await store.insert(ROW, withDocker);
      await store.insert(
        { ...ROW, dockerImages: null, dockerContainers: null, dockerVolumes: null, dockerBuildCache: null },
        withoutDocker,
      );
      expect((await store.latestDockerAt())?.toISOString()).toBe(withDocker.toISOString());
    });
  });

  it('deleteOlderThan removes only rows strictly older than the cutoff', async () => {
    await withCleanDb(async (prisma) => {
      const store = prismaSampleStore(prisma);
      const cutoff = new Date('2026-09-01T12:00:00.000Z');
      await store.insert(ROW, new Date('2026-09-01T11:59:59.000Z'));
      await store.insert(ROW, cutoff);
      await store.insert(ROW, new Date('2026-09-01T12:00:01.000Z'));
      expect(await store.deleteOlderThan(cutoff)).toBe(1);
      expect(await prisma.hostSample.count()).toBe(2);
    });
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm test lib/host/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 5: Write `lib/host/store.ts`**

```ts
import type { PrismaClient } from '@prisma/client';

/** One sample's worth of columns. `at` is supplied separately so the sampler
 *  and the seed can control it while production inserts default to now(). */
export type HostSampleInsert = {
  cpuJiffiesTotal: bigint;
  cpuJiffiesIdle: bigint;
  cpuJiffiesIowait: bigint;
  cpuCount: number;
  memTotal: bigint;
  memAvailable: bigint;
  diskTotal: bigint;
  diskAvailable: bigint;
  dockerImages: bigint | null;
  dockerContainers: bigint | null;
  dockerVolumes: bigint | null;
  dockerBuildCache: bigint | null;
  runningForges: number | null;
};

/**
 * The sampler's whole view of the database. Narrow on purpose: sampler tests
 * substitute a fake and stay pure, so only this file's tests need Postgres.
 */
export type SampleStore = {
  /** Timestamp of the newest sample, or null when the table is empty. */
  latestAt(): Promise<Date | null>;
  /** Timestamp of the newest sample that actually carries docker figures. */
  latestDockerAt(): Promise<Date | null>;
  insert(row: HostSampleInsert, at?: Date): Promise<void>;
  /** Deletes rows strictly older than `cutoff`; returns the count removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
};

export function prismaSampleStore(prisma: PrismaClient): SampleStore {
  return {
    async latestAt() {
      const row = await prisma.hostSample.findFirst({
        orderBy: { at: 'desc' },
        select: { at: true },
      });
      return row?.at ?? null;
    },

    async latestDockerAt() {
      const row = await prisma.hostSample.findFirst({
        where: { dockerImages: { not: null } },
        orderBy: { at: 'desc' },
        select: { at: true },
      });
      return row?.at ?? null;
    },

    async insert(row, at) {
      await prisma.hostSample.create({ data: at ? { ...row, at } : row });
    },

    async deleteOlderThan(cutoff) {
      const { count } = await prisma.hostSample.deleteMany({
        where: { at: { lt: cutoff } },
      });
      return count;
    },
  };
}
```

- [ ] **Step 6: Add the table to `withCleanDb`**

In `lib/test/db.ts`, inside `withCleanDb`, add before `return fn(prisma);`:

```ts
  await prisma.hostSample.deleteMany();
```

Order does not matter — `HostSample` has no foreign keys.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm test lib/host/store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/host/store.ts lib/host/store.test.ts lib/test/db.ts
git commit -m "feat(usage): HostSample table and sample store"
```

---

### Task 2: /proc parsers

**Files:**
- Create: `lib/host/proc.ts`
- Create: `lib/host/proc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type CpuJiffies = { total: bigint; idle: bigint; iowait: bigint }`, `parseCpuLine(text: string): CpuJiffies`, `parseMeminfo(text: string): { total: bigint; available: bigint }` (bytes).

- [ ] **Step 1: Write the failing test**

Create `lib/host/proc.test.ts`. The fixtures are verbatim captures from the pilot host:

```ts
import { describe, it, expect } from 'vitest';
import { parseCpuLine, parseMeminfo } from './proc';

const PROC_STAT = `cpu  6071251 13104 4865847 109790958 906528 0 105246 0 0 0
cpu0 6071251 13104 4865847 109790958 906528 0 105246 0 0 0
intr 1234567
ctxt 987654
`;

const MEMINFO = `MemTotal:       16373060 kB
MemFree:          468224 kB
MemAvailable:    6505424 kB
Buffers:          123456 kB
`;

describe('parseCpuLine', () => {
  it('sums every field into total and picks out idle and iowait', () => {
    // 6071251 + 13104 + 4865847 + 109790958 + 906528 + 0 + 105246 = 121752934
    expect(parseCpuLine(PROC_STAT)).toEqual({
      total: 121_752_934n,
      idle: 109_790_958n,
      iowait: 906_528n,
    });
  });

  it('reads only the aggregate line, not per-core lines', () => {
    const doubled = `cpu  1 0 1 8 0 0 0\ncpu0 999 999 999 999 999 999 999\n`;
    expect(parseCpuLine(doubled)).toEqual({ total: 10n, idle: 8n, iowait: 0n });
  });

  it('tolerates kernels reporting fewer columns', () => {
    expect(parseCpuLine('cpu  10 0 5 85\n')).toEqual({ total: 100n, idle: 85n, iowait: 0n });
  });

  it('throws when there is no aggregate cpu line', () => {
    expect(() => parseCpuLine('intr 1\n')).toThrow(/aggregate cpu line/i);
  });
});

describe('parseMeminfo', () => {
  it('converts kB to bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      total: 16_766_013_440n,
      available: 6_661_554_176n,
    });
  });

  it('throws when MemAvailable is absent', () => {
    expect(() => parseMeminfo('MemTotal: 100 kB\n')).toThrow(/MemAvailable/);
  });

  it('throws when MemTotal is absent', () => {
    expect(() => parseMeminfo('MemAvailable: 100 kB\n')).toThrow(/MemTotal/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test lib/host/proc.test.ts`
Expected: FAIL — cannot resolve `./proc`.

- [ ] **Step 3: Write `lib/host/proc.ts`**

```ts
/** Cumulative jiffies from /proc/stat's aggregate `cpu` line. */
export type CpuJiffies = { total: bigint; idle: bigint; iowait: bigint };

/**
 * Parse the aggregate `cpu` line of /proc/stat.
 *
 * `total` is the sum of every field — that denominator is what makes
 * (Δtotal - Δidle) / Δtotal an honest utilization figure. The aggregate line
 * already sums all cores, so the result needs no division by core count.
 * Field 4 is idle and field 5 is iowait; they are distinct, and iowait counts
 * as busy in the derived percentage while also being reported separately.
 */
export function parseCpuLine(text: string): CpuJiffies {
  const line = text
    .split('\n')
    .find((l) => /^cpu\s/.test(l));
  if (!line) throw new Error('/proc/stat has no aggregate cpu line');

  const fields = line.trim().split(/\s+/).slice(1).map((f) => BigInt(f));
  const total = fields.reduce((a, b) => a + b, 0n);
  return {
    total,
    idle: fields[3] ?? 0n,
    iowait: fields[4] ?? 0n,
  };
}

const KB = 1024n;

/** Parse /proc/meminfo's MemTotal and MemAvailable, in bytes. */
export function parseMeminfo(text: string): { total: bigint; available: bigint } {
  const read = (key: string): bigint => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${key}`);
    return BigInt(m[1]) * KB;
  };
  return { total: read('MemTotal'), available: read('MemAvailable') };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test lib/host/proc.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/host/proc.ts lib/host/proc.test.ts
git commit -m "feat(usage): /proc/stat and /proc/meminfo parsers"
```

---

### Task 3: ContainerManager gains `diskUsage()` and a running-only `list()`

**Files:**
- Modify: `lib/runtime/container/types.ts:52-79`
- Modify: `lib/runtime/container/docker-container-manager.ts` (add `dfFetch` to `DockerDeps` around line 86, add `diskUsage()`, adjust `list()` at line 180)
- Modify: `lib/runtime/container/fake-container-manager.ts` (add `diskUsage()`, extend `list()` at line 87)
- Modify: `lib/runtime/container/docker-container-manager.test.ts`
- Modify: `lib/runtime/container/fake-container-manager.test.ts`
- Modify: `lib/runtime/runner.ts:8` (export the label constant)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type DockerDiskUsage = { imagesBytes: number; containersBytes: number; volumesBytes: number; buildCacheBytes: number }`; `ContainerManager.diskUsage(): Promise<DockerDiskUsage>`; `ContainerManager.list(opts?: { label?: string; running?: boolean })`; `parseDockerDiskUsage(body: string): DockerDiskUsage`; `export const FORGE_LABEL = 'crystal-forge.forgeId'` from `lib/runtime/runner.ts`.

**Why the daemon socket and not the CLI:** `docker system df --format json` hangs; `--format '{{json .}}'` returns human strings (`"23.14GB"`); and summing `docker image inspect` sizes double-counts shared layers. `GET /system/df` returns exact integers. Its `LayersSize` field is the *deduplicated* image total — use it rather than summing `Images[].Size`.

- [ ] **Step 1: Write the failing parser and `diskUsage()` tests**

Append to `lib/runtime/container/docker-container-manager.test.ts`:

```ts
// Trimmed capture of GET /system/df from the pilot host, with the real totals.
const DF_PAYLOAD = JSON.stringify({
  LayersSize: 23135864692,
  Images: [{ Size: 900000000, SharedSize: 400000000 }],
  Containers: [{ SizeRw: 1560223744 }, {}],
  Volumes: [
    { UsageData: { Size: 25503138118 } },
    { UsageData: { Size: -1 } },
    { UsageData: null },
  ],
  BuildCache: [{ Size: 52456054000 }, { Size: 966 }],
});

describe('parseDockerDiskUsage', () => {
  it('reads exact byte totals, using deduplicated LayersSize for images', () => {
    expect(parseDockerDiskUsage(DF_PAYLOAD)).toEqual({
      imagesBytes: 23135864692,
      containersBytes: 1560223744,
      volumesBytes: 25503138118,
      buildCacheBytes: 52456054966,
    });
  });

  it('treats an uncomputed volume size (-1) as zero rather than subtracting', () => {
    const body = JSON.stringify({ LayersSize: 0, Volumes: [{ UsageData: { Size: -1 } }] });
    expect(parseDockerDiskUsage(body).volumesBytes).toBe(0);
  });

  it('defaults every missing section to zero', () => {
    expect(parseDockerDiskUsage('{}')).toEqual({
      imagesBytes: 0, containersBytes: 0, volumesBytes: 0, buildCacheBytes: 0,
    });
  });
});

describe('DockerContainerManager.diskUsage', () => {
  it('parses the injected /system/df body', async () => {
    const mgr = new DockerContainerManager({ dfFetch: async () => DF_PAYLOAD });
    await expect(mgr.diskUsage()).resolves.toMatchObject({ buildCacheBytes: 52456054966 });
  });

  it('propagates a fetch failure so the caller can null the columns', async () => {
    const mgr = new DockerContainerManager({
      dfFetch: async () => { throw new Error('timed out'); },
    });
    await expect(mgr.diskUsage()).rejects.toThrow(/timed out/);
  });
});

describe('DockerContainerManager.list', () => {
  it('passes -a by default, preserving existing behaviour', async () => {
    const calls: string[][] = [];
    const mgr = new DockerContainerManager({
      capture: async (_c, args) => { calls.push(args); return ''; },
    });
    await mgr.list({ label: 'crystal-forge.forgeId' });
    expect(calls[0]).toContain('-a');
  });

  it('omits -a and filters on status=running when running is true', async () => {
    const calls: string[][] = [];
    const mgr = new DockerContainerManager({
      capture: async (_c, args) => { calls.push(args); return ''; },
    });
    await mgr.list({ label: 'crystal-forge.forgeId', running: true });
    expect(calls[0]).not.toContain('-a');
    expect(calls[0]).toContain('--filter');
    expect(calls[0]).toContain('status=running');
  });
});
```

Add `parseDockerDiskUsage` to that file's existing import from `./docker-container-manager`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm test lib/runtime/container/docker-container-manager.test.ts`
Expected: FAIL — `parseDockerDiskUsage` is not exported and `diskUsage` is not a function.

- [ ] **Step 3: Add the type to `lib/runtime/container/types.ts`**

```ts
/**
 * Docker's own disk accounting, in exact bytes, from the daemon's /system/df.
 * `imagesBytes` is the DEDUPLICATED total (the endpoint's `LayersSize`), not the
 * sum of image sizes, which double-counts shared layers.
 */
export type DockerDiskUsage = {
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
};
```

In the `ContainerManager` type, replace the `list` signature and add `diskUsage`:

```ts
  /** List containers, optionally filtered by a `key=value` label. Includes
   *  stopped containers unless `running` is set — crashed forges do linger,
   *  since a probe timeout deliberately keeps the container. */
  list(opts?: { label?: string; running?: boolean }): Promise<ContainerSummary[]>;
  /**
   * Docker's disk consumption. EXPENSIVE: ~17 s on the pilot host, because the
   * daemon walks every image, volume and build-cache record. Callers must
   * rate-limit it (the usage sampler runs it every 30 min, not every tick).
   */
  diskUsage(): Promise<DockerDiskUsage>;
```

- [ ] **Step 4: Implement in `docker-container-manager.ts`**

Add the import at the top:

```ts
import { request as httpRequest } from 'node:http';
```

Add the socket reader and parser near `defaultCapture`:

```ts
const DOCKER_SOCKET = '/var/run/docker.sock';
const DF_TIMEOUT_MS = 30_000;

/**
 * GET /system/df from the docker daemon. Uses the unix socket rather than the
 * CLI because only the API returns exact bytes: `--format json` hangs, and
 * `--format '{{json .}}'` returns human strings like "23.14GB".
 *
 * The socket is idle while the daemon computes, so http's inactivity `timeout`
 * is an effective ceiling on the whole call.
 */
function defaultDfFetch(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: DOCKER_SOCKET, path: '/system/df', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error(`docker /system/df returned HTTP ${res.statusCode}`));
        });
      },
    );
    req.once('timeout', () => {
      req.destroy(new Error(`docker /system/df timed out after ${timeoutMs}ms`));
    });
    req.once('error', reject);
    req.end();
  });
}

/** Parse a /system/df body into exact byte totals. Exported for tests. */
export function parseDockerDiskUsage(body: string): DockerDiskUsage {
  const d = JSON.parse(body) as {
    LayersSize?: number;
    Containers?: ({ SizeRw?: number } | null)[] | null;
    Volumes?: ({ UsageData?: { Size?: number } | null } | null)[] | null;
    BuildCache?: ({ Size?: number } | null)[] | null;
  };
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    imagesBytes: d.LayersSize ?? 0,
    containersBytes: sum((d.Containers ?? []).map((c) => c?.SizeRw ?? 0)),
    // UsageData.Size is -1 when the daemon has not computed it; clamp so an
    // unknown volume reads as 0 instead of subtracting a byte.
    volumesBytes: sum((d.Volumes ?? []).map((v) => Math.max(v?.UsageData?.Size ?? 0, 0))),
    buildCacheBytes: sum((d.BuildCache ?? []).map((b) => b?.Size ?? 0)),
  };
}
```

Add `DockerDiskUsage` to the `import type { … } from './types'` list.

In `DockerDeps`, add:

```ts
  /** Injectable for tests; fetches the raw /system/df body. */
  dfFetch?: (timeoutMs: number) => Promise<string>;
```

In the class, add the field, assign it in the constructor beside `this.capture`, and add the method:

```ts
  private readonly dfFetch: (timeoutMs: number) => Promise<string>;
  // in the constructor:
  this.dfFetch = deps.dfFetch ?? ((ms) => defaultDfFetch(ms));

  async diskUsage(): Promise<DockerDiskUsage> {
    return parseDockerDiskUsage(await this.dfFetch(DF_TIMEOUT_MS));
  }
```

Change `list` so `-a` is conditional (keeping argument order identical for the default path, which existing tests assert):

```ts
  async list(opts: { label?: string; running?: boolean } = {}): Promise<ContainerSummary[]> {
    const args = [
      'ps',
      ...(opts.running ? [] : ['-a']),
      '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}',
    ];
    if (opts.label) args.push('--filter', `label=${opts.label}`);
    if (opts.running) args.push('--filter', 'status=running');
```

Leave the rest of the method body untouched.

- [ ] **Step 5: Run the docker tests and confirm they pass**

Run: `pnpm test lib/runtime/container/docker-container-manager.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Write the failing fake-manager tests**

Append to `lib/runtime/container/fake-container-manager.test.ts`:

```ts
describe('FakeContainerManager.diskUsage', () => {
  it('returns fixed figures so the sampler works under FORGE_RUNTIME_MODE=fake', async () => {
    const mgr = new FakeContainerManager();
    await expect(mgr.diskUsage()).resolves.toEqual({
      imagesBytes: 1_000_000_000,
      containersBytes: 2_000_000,
      volumesBytes: 500_000_000,
      buildCacheBytes: 3_000_000_000,
    });
  });

  it('can be told to fail, so callers can test the null-columns path', async () => {
    const mgr = new FakeContainerManager();
    mgr.diskUsageError = new Error('daemon down');
    await expect(mgr.diskUsage()).rejects.toThrow(/daemon down/);
  });
});

describe('FakeContainerManager.list with running', () => {
  it('omits stopped containers when running is true', async () => {
    const mgr = new FakeContainerManager();
    const kept = await mgr.create({ name: 'a', image: 'i', labels: { 'crystal-forge.forgeId': 'f1' } });
    const stopped = await mgr.create({ name: 'b', image: 'i', labels: { 'crystal-forge.forgeId': 'f2' } });
    await mgr.stop(stopped);

    const all = await mgr.list({ label: 'crystal-forge.forgeId' });
    expect(all).toHaveLength(2);

    const running = await mgr.list({ label: 'crystal-forge.forgeId', running: true });
    expect(running.map((c) => c.id)).toEqual([kept]);
  });
});
```

- [ ] **Step 7: Run them and confirm they fail**

Run: `pnpm test lib/runtime/container/fake-container-manager.test.ts`
Expected: FAIL — `diskUsage` is not a function.

- [ ] **Step 8: Implement in `fake-container-manager.ts`**

Add the field and method to the class:

```ts
  /** Mutable so a test can assert a specific figure reaches the store. */
  diskUsageResult: DockerDiskUsage = {
    imagesBytes: 1_000_000_000,
    containersBytes: 2_000_000,
    volumesBytes: 500_000_000,
    buildCacheBytes: 3_000_000_000,
  };
  /** Set to make diskUsage() reject, exercising the null-columns path. */
  diskUsageError: Error | null = null;

  async diskUsage(): Promise<DockerDiskUsage> {
    if (this.diskUsageError) throw this.diskUsageError;
    return this.diskUsageResult;
  }
```

Add `DockerDiskUsage` to the file's `import type { … } from './types'`.

Then **read the existing `list` method (around line 87) and add only a `running` filter to it** — keep its label-matching logic exactly as it is, and widen its parameter type to `{ label?: string; running?: boolean }`. The `Entry` type already carries `running`, so the filter is one predicate: skip entries where `opts.running && !entry.running`. The test in Step 6 is the specification; do not restructure the rest of the method.

- [ ] **Step 9: Run the fake tests and confirm they pass**

Run: `pnpm test lib/runtime/container/fake-container-manager.test.ts`
Expected: PASS.

- [ ] **Step 10: Export the forge label constant**

In `lib/runtime/runner.ts:8`, change:

```ts
const FORGE_LABEL = 'crystal-forge.forgeId';
```

to:

```ts
export const FORGE_LABEL = 'crystal-forge.forgeId';
```

(The string is already duplicated at `lib/services/runtime.ts:185`; exporting it lets the sampler share the canonical one rather than adding a third copy.)

- [ ] **Step 11: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: clean. If any other `ContainerManager` implementation exists in test helpers, it now needs `diskUsage` — add it there rather than loosening the interface.

- [ ] **Step 12: Commit**

```bash
git add lib/runtime/container lib/runtime/runner.ts
git commit -m "feat(usage): ContainerManager.diskUsage() and running-only list()"
```

---

### Task 4: Host snapshot reader

**Files:**
- Create: `lib/host/read.ts`
- Create: `lib/host/read.test.ts`

**Interfaces:**
- Consumes: `parseCpuLine`, `parseMeminfo` (Task 2).
- Produces: `type HostSnapshot`, `type HostReaderDeps`, `readHostSnapshot(deps?): Promise<HostSnapshot>`, `const DISK_MOUNT = '/'`.

- [ ] **Step 1: Write the failing test**

Create `lib/host/read.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readHostSnapshot } from './read';

const PROC_STAT = 'cpu  6071251 13104 4865847 109790958 906528 0 105246 0 0 0\n';
const MEMINFO = 'MemTotal:       16373060 kB\nMemAvailable:    6505424 kB\n';

// Real statfs('/') output from the pilot host. bavail < bfree: the difference
// is root-reserved and must NOT be reported as free.
const STATFS = { blocks: 65506593, bfree: 33875802, bavail: 30530049, frsize: 4096 };

function deps(overrides: Partial<Parameters<typeof readHostSnapshot>[0]> = {}) {
  return {
    readText: async (p: string) => {
      if (p === '/proc/stat') return PROC_STAT;
      if (p === '/proc/meminfo') return MEMINFO;
      throw new Error(`unexpected read: ${p}`);
    },
    statfsPath: async () => STATFS,
    cpuCount: () => 1,
    ...overrides,
  };
}

describe('readHostSnapshot', () => {
  it('assembles jiffies, memory bytes and disk bytes', async () => {
    await expect(readHostSnapshot(deps())).resolves.toEqual({
      cpuJiffiesTotal: 121_752_934n,
      cpuJiffiesIdle: 109_790_958n,
      cpuJiffiesIowait: 906_528n,
      cpuCount: 1,
      memTotal: 16_766_013_440n,
      memAvailable: 6_661_554_176n,
      diskTotal: 268_315_004_928n,
      diskAvailable: 125_051_080_704n,
    });
  });

  it('uses bavail, not bfree', async () => {
    const snap = await readHostSnapshot(deps());
    // bfree would give 138,755,284,992 — larger, and wrong.
    expect(snap.diskAvailable).toBe(BigInt(STATFS.bavail) * BigInt(STATFS.frsize));
  });

  it('propagates a /proc read failure so the sampler can skip the tick', async () => {
    await expect(
      readHostSnapshot(deps({ readText: async () => { throw new Error('EACCES'); } })),
    ).rejects.toThrow(/EACCES/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test lib/host/read.test.ts`
Expected: FAIL — cannot resolve `./read`.

- [ ] **Step 3: Write `lib/host/read.ts`**

```ts
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { parseCpuLine, parseMeminfo } from './proc';

/** The filesystem whose capacity is tracked. This host has a single root fs. */
export const DISK_MOUNT = '/';

export type HostSnapshot = {
  cpuJiffiesTotal: bigint;
  cpuJiffiesIdle: bigint;
  cpuJiffiesIowait: bigint;
  cpuCount: number;
  memTotal: bigint;
  memAvailable: bigint;
  diskTotal: bigint;
  diskAvailable: bigint;
};

export type HostReaderDeps = {
  readText?: (path: string) => Promise<string>;
  statfsPath?: (path: string) => Promise<{ blocks: number; bavail: number; frsize: number }>;
  cpuCount?: () => number;
};

/**
 * One reading of the host. The dashboard runs as a host systemd unit, not in a
 * container (deploy/systemd/crystal-forge.service), so /proc and statfs report
 * real host figures.
 */
export async function readHostSnapshot(deps: HostReaderDeps = {}): Promise<HostSnapshot> {
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'));
  const statfsPath = deps.statfsPath ?? ((p: string) => statfs(p));
  const cpuCount = deps.cpuCount ?? (() => os.cpus().length);

  const [statText, memText, fs] = await Promise.all([
    readText('/proc/stat'),
    readText('/proc/meminfo'),
    statfsPath(DISK_MOUNT),
  ]);

  const cpu = parseCpuLine(statText);
  const mem = parseMeminfo(memText);
  const frsize = BigInt(fs.frsize);

  return {
    cpuJiffiesTotal: cpu.total,
    cpuJiffiesIdle: cpu.idle,
    cpuJiffiesIowait: cpu.iowait,
    cpuCount: cpuCount(),
    memTotal: mem.total,
    memAvailable: mem.available,
    diskTotal: BigInt(fs.blocks) * frsize,
    // bavail, not bfree: the difference is root-reserved and unavailable to a build.
    diskAvailable: BigInt(fs.bavail) * frsize,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test lib/host/read.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Sanity-check against the real host**

Run: `pnpm exec tsx -e "import('./lib/host/read').then(async m => console.log(await m.readHostSnapshot()))"`
Expected: plausible figures — `cpuCount: 1`, `memTotal` ≈ 16.7e9, `diskTotal` ≈ 268e9. Compare `diskTotal` against `df -h /`.

- [ ] **Step 6: Commit**

```bash
git add lib/host/read.ts lib/host/read.test.ts
git commit -m "feat(usage): host snapshot reader"
```

---

### Task 5: The sampler, its env vars, and boot wiring

**Files:**
- Create: `lib/host/sampler.ts`
- Create: `lib/host/sampler.test.ts`
- Modify: `lib/env.ts` (add two vars next to `FORGE_RECONCILE_INTERVAL_MS`)
- Modify: `instrumentation.ts` (start it before the dev/prod mode split)

**Interfaces:**
- Consumes: `SampleStore`, `HostSampleInsert` (Task 1); `HostSnapshot` (Task 4); `DockerDiskUsage`, `FORGE_LABEL` (Task 3).
- Produces: `DOCKER_SAMPLE_INTERVAL_MS`, `type SamplerDeps`, `type SamplerOpts`, `sampleOnce(deps, opts): Promise<'written' | 'skipped'>`, `startUsageSampler(deps, opts): { stop: () => void }`.

**The two guards that matter.** `pnpm dev` is `tsx server.ts` — the same entry as `pnpm start` — so on this host a dev server and the live service can run against one database; the dedupe guard makes two samplers interleave into one clean series instead of doubling it. And the docker cadence is decided **from the data, not a tick counter**, because a counter resets on every dashboard restart (every deploy) and would double up with two samplers.

- [ ] **Step 1: Write the failing test**

Create `lib/host/sampler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { sampleOnce, startUsageSampler, DOCKER_SAMPLE_INTERVAL_MS, type SamplerDeps } from './sampler';
import type { HostSampleInsert, SampleStore } from './store';
import type { HostSnapshot } from './read';

const SNAPSHOT: HostSnapshot = {
  cpuJiffiesTotal: 121_752_934n,
  cpuJiffiesIdle: 109_790_958n,
  cpuJiffiesIowait: 906_528n,
  cpuCount: 1,
  memTotal: 16_766_013_440n,
  memAvailable: 6_661_554_176n,
  diskTotal: 268_315_004_928n,
  diskAvailable: 125_051_080_704n,
};

const DOCKER = {
  imagesBytes: 23_135_864_692,
  containersBytes: 1_560_223_744,
  volumesBytes: 25_503_138_118,
  buildCacheBytes: 52_456_054_966,
};

const OPTS = { intervalMs: 300_000, retentionDays: 90, dockerIntervalMs: DOCKER_SAMPLE_INTERVAL_MS };

type Written = { at: Date; row: HostSampleInsert };

function fakeStore(seed: Written[] = []) {
  const rows = [...seed];
  const cutoffs: Date[] = [];
  const store: SampleStore & { rows: Written[]; cutoffs: Date[] } = {
    rows,
    cutoffs,
    latestAt: async () => (rows.length ? rows[rows.length - 1].at : null),
    latestDockerAt: async () => {
      const withDocker = rows.filter((r) => r.row.dockerImages !== null);
      return withDocker.length ? withDocker[withDocker.length - 1].at : null;
    },
    insert: async (row, at) => { rows.push({ at: at ?? new Date(), row }); },
    deleteOlderThan: async (cutoff) => { cutoffs.push(cutoff); return 0; },
  };
  return store;
}

function deps(over: Partial<SamplerDeps> = {}): SamplerDeps & { store: ReturnType<typeof fakeStore> } {
  const store = (over.store as ReturnType<typeof fakeStore>) ?? fakeStore();
  return {
    store,
    readSnapshot: async () => SNAPSHOT,
    readDocker: async () => DOCKER,
    countRunningForges: async () => 3,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    ...over,
    store,
  };
}

describe('sampleOnce', () => {
  it('writes one row carrying the snapshot, docker figures and forge count', async () => {
    const d = deps();
    await expect(sampleOnce(d, OPTS)).resolves.toBe('written');
    expect(d.store.rows).toHaveLength(1);
    expect(d.store.rows[0].row).toMatchObject({
      cpuJiffiesTotal: 121_752_934n,
      cpuJiffiesIowait: 906_528n,
      memAvailable: 6_661_554_176n,
      diskAvailable: 125_051_080_704n,
      dockerBuildCache: 52_456_054_966n,
      runningForges: 3,
    });
  });

  it('samples docker on the very first tick, when no docker row exists yet', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    await sampleOnce(deps({ readDocker }), OPTS);
    expect(readDocker).toHaveBeenCalledTimes(1);
  });

  it('skips the whole tick when the newest row is younger than half the interval', async () => {
    const store = fakeStore([
      { at: new Date('2026-09-01T11:58:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    const d = deps({ store });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('skipped');
    expect(d.store.rows).toHaveLength(1);
  });

  it('leaves docker columns null when the newest docker row is too recent', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    // 25 min old: inside the 30 min cadence (threshold is 30 min - interval/2).
    const store = fakeStore([
      { at: new Date('2026-09-01T11:35:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    const d = deps({ store, readDocker });
    await sampleOnce(d, OPTS);
    expect(readDocker).not.toHaveBeenCalled();
    expect(d.store.rows[1].row).toMatchObject({
      dockerImages: null, dockerContainers: null, dockerVolumes: null, dockerBuildCache: null,
    });
  });

  it('samples docker again once the newest docker row has aged past the cadence', async () => {
    const readDocker = vi.fn(async () => DOCKER);
    // 28 min old: past the 27.5 min threshold.
    const store = fakeStore([
      { at: new Date('2026-09-01T11:32:00.000Z'), row: { dockerImages: 1n } as HostSampleInsert },
    ]);
    await sampleOnce(deps({ store, readDocker }), OPTS);
    expect(readDocker).toHaveBeenCalledTimes(1);
  });

  it('still writes host figures when docker fails', async () => {
    const d = deps({ readDocker: async () => { throw new Error('daemon down'); } });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('written');
    expect(d.store.rows[0].row).toMatchObject({ dockerImages: null, memTotal: 16_766_013_440n });
  });

  it('writes nothing when the /proc read fails', async () => {
    const d = deps({ readSnapshot: async () => { throw new Error('EACCES'); } });
    await expect(sampleOnce(d, OPTS)).resolves.toBe('skipped');
    expect(d.store.rows).toHaveLength(0);
  });

  it('nulls only runningForges when the container list fails', async () => {
    const d = deps({ countRunningForges: async () => { throw new Error('docker gone'); } });
    await sampleOnce(d, OPTS);
    expect(d.store.rows[0].row).toMatchObject({ runningForges: null, memTotal: 16_766_013_440n });
  });

  it('prunes rows older than the retention window', async () => {
    const d = deps();
    await sampleOnce(d, OPTS);
    expect(d.store.cutoffs[0].toISOString()).toBe('2026-06-03T12:00:00.000Z');
  });
});

describe('startUsageSampler', () => {
  it('ticks immediately and on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ now: () => new Date(Date.now()) });
      const handle = startUsageSampler(d, OPTS);
      await vi.advanceTimersByTimeAsync(0);
      expect(d.store.rows).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(300_000);
      expect(d.store.rows).toHaveLength(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(900_000);
      expect(d.store.rows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack ticks while one is still in flight', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | null = null;
      const readSnapshot = vi.fn(
        () => new Promise<HostSnapshot>((resolve) => {
          release = () => resolve(SNAPSHOT);
        }),
      );
      const d = deps({ readSnapshot, now: () => new Date(Date.now()) });
      const handle = startUsageSampler(d, OPTS);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000); // two more interval boundaries
      expect(readSnapshot).toHaveBeenCalledTimes(1);
      release?.();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test lib/host/sampler.test.ts`
Expected: FAIL — cannot resolve `./sampler`.

- [ ] **Step 3: Write `lib/host/sampler.ts`**

```ts
import type { DockerDiskUsage } from '@/lib/runtime/container/types';
import type { HostSnapshot } from './read';
import type { SampleStore } from './store';

/**
 * How often the docker breakdown is sampled. NOT env-configurable: it is a
 * property of how expensive the call is (~17 s on the pilot host, where the
 * daemon walks 145 images / 32 volumes / 1128 build-cache records), not a
 * preference. Running it every 5 min would be a ~6 % duty cycle of disk-walking
 * on a 1-vCPU box.
 */
export const DOCKER_SAMPLE_INTERVAL_MS = 1_800_000;

const DAY_MS = 86_400_000;

export type SamplerDeps = {
  store: SampleStore;
  readSnapshot: () => Promise<HostSnapshot>;
  readDocker: () => Promise<DockerDiskUsage>;
  countRunningForges: () => Promise<number>;
  now?: () => Date;
};

export type SamplerOpts = {
  intervalMs: number;
  retentionDays: number;
  dockerIntervalMs?: number;
};

/**
 * One tick. Returns 'skipped' when nothing was written — either another sampler
 * beat us to this slot, or the host read failed.
 */
export async function sampleOnce(
  deps: SamplerDeps,
  opts: SamplerOpts,
): Promise<'written' | 'skipped'> {
  const now = deps.now?.() ?? new Date();
  const dockerIntervalMs = opts.dockerIntervalMs ?? DOCKER_SAMPLE_INTERVAL_MS;

  // Two samplers can share one database on this host (pnpm dev and the live
  // service run the same entry point). Whoever gets here second stands down, so
  // the series stays evenly spaced instead of doubling up.
  const latest = await deps.store.latestAt();
  if (latest && now.getTime() - latest.getTime() < opts.intervalMs / 2) return 'skipped';

  let snapshot: HostSnapshot;
  try {
    snapshot = await deps.readSnapshot();
  } catch (err) {
    // Nothing meaningful to store without the host figures — skip rather than
    // write a half-empty row that would pollute the series.
    console.error('[usage/sampler] host read failed', err);
    return 'skipped';
  }

  // Decide the docker cadence from the DATA, not a tick counter: a counter
  // resets on every dashboard restart (which happens on every deploy) and would
  // double up whenever two samplers interleave. The half-interval slack keeps a
  // sample landing a few hundred ms early from deferring docker a whole cycle.
  let docker: DockerDiskUsage | null = null;
  const latestDocker = await deps.store.latestDockerAt();
  const dockerDue =
    !latestDocker ||
    now.getTime() - latestDocker.getTime() >= dockerIntervalMs - opts.intervalMs / 2;
  if (dockerDue) {
    try {
      docker = await deps.readDocker();
    } catch (err) {
      console.error('[usage/sampler] docker disk usage failed; columns left null', err);
    }
  }

  let runningForges: number | null = null;
  try {
    runningForges = await deps.countRunningForges();
  } catch (err) {
    console.error('[usage/sampler] running-forge count failed', err);
  }

  await deps.store.insert(
    {
      ...snapshot,
      dockerImages: docker ? BigInt(docker.imagesBytes) : null,
      dockerContainers: docker ? BigInt(docker.containersBytes) : null,
      dockerVolumes: docker ? BigInt(docker.volumesBytes) : null,
      dockerBuildCache: docker ? BigInt(docker.buildCacheBytes) : null,
      runningForges,
    },
    now,
  );

  await deps.store.deleteOlderThan(new Date(now.getTime() - opts.retentionDays * DAY_MS));
  return 'written';
}

/** Start the sampling loop: one tick immediately, then every intervalMs. */
export function startUsageSampler(deps: SamplerDeps, opts: SamplerOpts): { stop: () => void } {
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await sampleOnce(deps, opts);
    } catch (err) {
      console.error('[usage/sampler] tick failed', err);
    } finally {
      inFlight = false;
    }
  }

  void tick();
  const handle = setInterval(() => { void tick(); }, opts.intervalMs);
  (handle as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(handle) };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test lib/host/sampler.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Add the env vars**

In `lib/env.ts`, immediately after the `FORGE_RECONCILE_INTERVAL_MS` line:

```ts
  // Host usage sampler (see lib/host/sampler.ts). 0 disables it — set that way
  // in the e2e suite, which seeds deterministic rows instead of waiting 5 min
  // for a real sample.
  FORGE_USAGE_SAMPLE_MS: z.coerce.number().int().min(0).default(300000),
  FORGE_USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
```

- [ ] **Step 6: Wire it into `instrumentation.ts`**

Insert immediately **before** the `const mode = process.env.FORGE_DASHBOARD_MODE === 'prod' ? 'prod' : 'dev';` line, so both dashboard modes sample their own host:

```ts
  // Host usage sampler for /admin/usage. Runs in both modes — each dashboard
  // samples the host it runs on. Wrapped so a sampler failure can never keep
  // the dashboard from booting.
  if (env.FORGE_USAGE_SAMPLE_MS > 0) {
    try {
      const { startUsageSampler, DOCKER_SAMPLE_INTERVAL_MS } = await import('./lib/host/sampler');
      const { prismaSampleStore } = await import('./lib/host/store');
      const { readHostSnapshot } = await import('./lib/host/read');
      const { getContainerManager } = await import('@/lib/runtime/container');
      const { FORGE_LABEL } = await import('./lib/runtime/runner');
      const { prisma } = await import('./lib/prisma');
      const mgr = getContainerManager();
      startUsageSampler(
        {
          store: prismaSampleStore(prisma),
          readSnapshot: () => readHostSnapshot(),
          readDocker: () => mgr.diskUsage(),
          countRunningForges: async () =>
            (await mgr.list({ label: FORGE_LABEL, running: true })).length,
        },
        {
          intervalMs: env.FORGE_USAGE_SAMPLE_MS,
          retentionDays: env.FORGE_USAGE_RETENTION_DAYS,
          dockerIntervalMs: DOCKER_SAMPLE_INTERVAL_MS,
        },
      );
      console.info('[instrumentation] host usage sampler started');
    } catch (err) {
      console.error('[instrumentation] usage sampler failed to start', err);
    }
  }
```

- [ ] **Step 7: Verify it writes a real row**

Run: `pnpm typecheck && pnpm test lib/host`
Expected: clean, all host tests pass.

Then, against the **dev** database (read-only apart from the sampler's own inserts):

Run: `pnpm dev` in one terminal; watch for `[instrumentation] host usage sampler started`.
Run: `docker exec crystal-forge-pg psql -U postgres -d crystal_forge -c 'select at, "cpuCount", "dockerBuildCache", "runningForges" from "HostSample" order by at desc limit 3;'`
Expected: one row within seconds of boot, with docker columns **populated** (first tick), then a second row 5 minutes later with docker columns **null**. Stop the dev server afterwards.

- [ ] **Step 8: Commit**

```bash
git add lib/host/sampler.ts lib/host/sampler.test.ts lib/env.ts instrumentation.ts
git commit -m "feat(usage): sampling loop, env vars and boot wiring"
```

---

### Task 6: Series derivation

**Files:**
- Create: `lib/host/series.ts`
- Create: `lib/host/series.test.ts`

**Interfaces:**
- Consumes: nothing (pure; takes plain rows).
- Produces: `type UsageRange`, `RANGES`, `DOCKER_MIN_BUCKET_MS`, `GAP_FACTOR`, `type SampleRow`, `type UsagePoint`, `type DockerPoint`, `type UsageLatest`, `type UsageSeries`, `buildSeries(rows, opts): UsageSeries`.

This is where every sharp edge lives. Read the spec's "Read path and aggregation" section before starting.

- [ ] **Step 1: Write the failing test**

Create `lib/host/series.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSeries, RANGES, type SampleRow } from './series';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const INTERVAL = 300_000; // 5 min
// A 1-vCPU host at 100 Hz accrues 30,000 jiffies per 5-minute interval.
const JIFFIES_PER_INTERVAL = 30_000n;

function row(minutes: number, over: Partial<SampleRow> = {}): SampleRow {
  return {
    at: new Date(T0 + minutes * 60_000),
    cpuJiffiesTotal: 0n,
    cpuJiffiesIdle: 0n,
    cpuJiffiesIowait: 0n,
    cpuCount: 1,
    memTotal: 16_000_000_000n,
    memAvailable: 8_000_000_000n,
    diskTotal: 250_000_000_000n,
    diskAvailable: 125_000_000_000n,
    dockerImages: null,
    dockerContainers: null,
    dockerVolumes: null,
    dockerBuildCache: null,
    runningForges: 2,
    ...over,
  };
}

const OPTS = { range: '24h' as const, sampleIntervalMs: INTERVAL };

describe('buildSeries', () => {
  it('returns an empty series with no latest for no rows', () => {
    expect(buildSeries([], OPTS)).toMatchObject({ points: [], docker: [], latest: null });
  });

  it('reports a fully busy interval as 100 %', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: JIFFIES_PER_INTERVAL, cpuJiffiesIdle: 0n })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(100);
  });

  it('reports a fully idle interval as 0 %', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: JIFFIES_PER_INTERVAL, cpuJiffiesIdle: JIFFIES_PER_INTERVAL })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(0);
  });

  it('counts iowait as busy and also reports it separately', () => {
    const series = buildSeries(
      [
        row(0),
        row(5, {
          cpuJiffiesTotal: 30_000n,
          cpuJiffiesIdle: 21_000n,   // 70 % idle
          cpuJiffiesIowait: 6_000n,  // 20 % iowait, inside the 30 % busy
        }),
      ],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeCloseTo(30, 6);
    expect(series.points.at(-1)?.iowaitPct).toBeCloseTo(20, 6);
  });

  it('emits a null cpu when the counter goes backwards (reboot)', () => {
    const series = buildSeries(
      [
        row(0, { cpuJiffiesTotal: 900_000n, cpuJiffiesIdle: 600_000n }),
        row(5, { cpuJiffiesTotal: 1_000n, cpuJiffiesIdle: 500n }), // rebooted
      ],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeNull();
    // Memory is still a valid gauge reading across a reboot.
    expect(series.points.at(-1)?.memUsedBytes).toBe(8_000_000_000);
  });

  it('emits a null cpu when the gap exceeds 3x the sample interval', () => {
    const series = buildSeries(
      [row(0), row(20, { cpuJiffiesTotal: 120_000n, cpuJiffiesIdle: 0n })], // 20 min > 15 min
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBeNull();
  });

  it('accepts a gap of exactly 3x the interval', () => {
    const series = buildSeries(
      [row(0), row(15, { cpuJiffiesTotal: 90_000n, cpuJiffiesIdle: 0n })],
      OPTS,
    );
    expect(series.points.at(-1)?.cpuPct).toBe(100);
  });

  it('emits all-null points for buckets with no samples, so the line breaks', () => {
    const series = buildSeries([row(0), row(30)], OPTS);
    // 24h range buckets at 5 min: 00:00 … 00:30 is 7 buckets.
    expect(series.points).toHaveLength(7);
    expect(series.points[3]).toMatchObject({ cpuPct: null, memUsedBytes: null });
  });

  it('reports a bucket mean below its peak when one interval inside it is hot', () => {
    // 7d buckets at 1 h with 5-minute samples: all three rows land in ONE bucket,
    // giving it two intervals — one fully idle, one fully busy.
    const series = buildSeries(
      [
        row(0),
        row(5, { cpuJiffiesTotal: 30_000n, cpuJiffiesIdle: 30_000n }), // idle
        row(10, { cpuJiffiesTotal: 60_000n, cpuJiffiesIdle: 30_000n }), // busy
      ],
      { range: '7d', sampleIntervalMs: INTERVAL },
    );
    expect(series.points).toHaveLength(1);
    expect(series.points[0].cpuPct).toBeCloseTo(50, 6);
    expect(series.points[0].cpuPeakPct).toBeCloseTo(100, 6);
  });

  it('derives memory used as total - available, and reports a peak', () => {
    const series = buildSeries(
      [
        row(0, { memAvailable: 8_000_000_000n }),
        row(5, { memAvailable: 2_000_000_000n }),
      ],
      OPTS,
    );
    expect(series.points[0].memUsedBytes).toBe(8_000_000_000);
    expect(series.points.at(-1)?.memUsedBytes).toBe(14_000_000_000);
    expect(series.points.at(-1)?.memPeakBytes).toBe(14_000_000_000);
    expect(series.points.at(-1)?.memTotalBytes).toBe(16_000_000_000);
  });

  it('buckets docker rows at 30 minutes minimum, taking the last per bucket', () => {
    const docker = (n: bigint) => ({
      dockerImages: n, dockerContainers: n, dockerVolumes: n, dockerBuildCache: n,
    });
    const series = buildSeries(
      [
        row(0, docker(1n)),
        row(5),                     // no docker columns
        row(29, docker(2n)),        // same 30-min bucket as minute 0 — wins
        row(35, docker(3n)),        // next bucket
      ],
      OPTS,
    );
    expect(series.dockerBucketMs).toBe(1_800_000);
    expect(series.docker.map((d) => d.imagesBytes)).toEqual([2, 3]);
  });

  it('reports latest from the final row, with cpu from the final valid interval', () => {
    const series = buildSeries(
      [row(0), row(5, { cpuJiffiesTotal: 30_000n, cpuJiffiesIdle: 15_000n, runningForges: 4 })],
      OPTS,
    );
    expect(series.latest).toMatchObject({
      cpuPct: 50,
      memUsedBytes: 8_000_000_000,
      memTotalBytes: 16_000_000_000,
      diskUsedBytes: 125_000_000_000,
      diskTotalBytes: 250_000_000_000,
      runningForges: 4,
      cpuCount: 1,
    });
  });

  it('carries the bucket size for the requested range', () => {
    expect(buildSeries([row(0)], { range: '90d', sampleIntervalMs: INTERVAL }).bucketMs)
      .toBe(RANGES['90d'].bucketMs);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test lib/host/series.test.ts`
Expected: FAIL — cannot resolve `./series`.

- [ ] **Step 3: Write `lib/host/series.ts`**

```ts
export type UsageRange = '24h' | '7d' | '30d' | '90d';

/**
 * Window and bucket per range, chosen to keep every chart between ~170 and ~290
 * points: legible, and ~30 KB of JSON.
 */
export const RANGES: Record<UsageRange, { windowMs: number; bucketMs: number }> = {
  '24h': { windowMs: 86_400_000, bucketMs: 300_000 },
  '7d': { windowMs: 604_800_000, bucketMs: 3_600_000 },
  '30d': { windowMs: 2_592_000_000, bucketMs: 14_400_000 },
  '90d': { windowMs: 7_776_000_000, bucketMs: 43_200_000 },
};

/** Docker columns are only written every 30 min, so never bucket them finer. */
export const DOCKER_MIN_BUCKET_MS = 1_800_000;

/** A gap wider than this many sample intervals breaks the line. */
export const GAP_FACTOR = 3;

export type SampleRow = {
  at: Date;
  cpuJiffiesTotal: bigint;
  cpuJiffiesIdle: bigint;
  cpuJiffiesIowait: bigint;
  cpuCount: number;
  memTotal: bigint;
  memAvailable: bigint;
  diskTotal: bigint;
  diskAvailable: bigint;
  dockerImages: bigint | null;
  dockerContainers: bigint | null;
  dockerVolumes: bigint | null;
  dockerBuildCache: bigint | null;
  runningForges: number | null;
};

export type UsagePoint = {
  at: string;
  cpuPct: number | null;
  cpuPeakPct: number | null;
  iowaitPct: number | null;
  memUsedBytes: number | null;
  memPeakBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  runningForges: number | null;
};

export type DockerPoint = {
  at: string;
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
};

export type UsageLatest = {
  at: string;
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  runningForges: number | null;
  cpuCount: number;
};

export type UsageSeries = {
  range: UsageRange;
  bucketMs: number;
  dockerBucketMs: number;
  points: UsagePoint[];
  docker: DockerPoint[];
  latest: UsageLatest | null;
};

/** One CPU interval between two consecutive rows, or null when unusable. */
type Interval = { endMs: number; dTotal: number; dBusy: number; dIowait: number } | null;

type Bucket = {
  dTotal: number;
  dBusy: number;
  dIowait: number;
  peakPct: number | null;
  memUsed: number[];
  memTotal: number | null;
  diskUsed: number[];
  diskTotal: number | null;
  runningForges: number | null;
};

const bucketStart = (ms: number, bucketMs: number): number => Math.floor(ms / bucketMs) * bucketMs;

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function emptyBucket(): Bucket {
  return {
    dTotal: 0, dBusy: 0, dIowait: 0, peakPct: null,
    memUsed: [], memTotal: null, diskUsed: [], diskTotal: null, runningForges: null,
  };
}

/**
 * Turn raw samples into a bucketed series.
 *
 * CPU comes from deltas between consecutive rows — the stored counters are
 * cumulative — so a bucket's mean is (Σ busy jiffies / Σ total jiffies) across
 * its intervals, which stays correct even when samples are unevenly spaced.
 * Two conditions make an interval unusable and emit null rather than a
 * fabricated number: a gap wider than GAP_FACTOR intervals (a downtime or a
 * deploy window), and a counter that went backwards (a reboot).
 *
 * Buckets run from the first sample to the last, not across the whole window: a
 * three-day-old install asked for 90 days should draw three days, not 87 empty
 * buckets. Buckets with no samples inside that span DO get an all-null point,
 * so a real outage reads as a break in the line.
 */
export function buildSeries(
  rows: SampleRow[],
  opts: { range: UsageRange; sampleIntervalMs: number },
): UsageSeries {
  const { bucketMs } = RANGES[opts.range];
  const dockerBucketMs = Math.max(bucketMs, DOCKER_MIN_BUCKET_MS);
  const base = { range: opts.range, bucketMs, dockerBucketMs };

  if (rows.length === 0) return { ...base, points: [], docker: [], latest: null };

  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const maxGapMs = opts.sampleIntervalMs * GAP_FACTOR;

  const intervals: Interval[] = sorted.map((curr, i) => {
    if (i === 0) return null;
    const prev = sorted[i - 1];
    const dtMs = curr.at.getTime() - prev.at.getTime();
    if (dtMs > maxGapMs) return null;
    if (curr.cpuJiffiesTotal < prev.cpuJiffiesTotal) return null; // reboot
    const dTotal = Number(curr.cpuJiffiesTotal - prev.cpuJiffiesTotal);
    if (dTotal <= 0) return null;
    const dIdle = Number(curr.cpuJiffiesIdle - prev.cpuJiffiesIdle);
    return {
      endMs: curr.at.getTime(),
      dTotal,
      dBusy: dTotal - dIdle,
      dIowait: Number(curr.cpuJiffiesIowait - prev.cpuJiffiesIowait),
    };
  });

  const buckets = new Map<number, Bucket>();
  const at = (ms: number): Bucket => {
    const key = bucketStart(ms, bucketMs);
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh = emptyBucket();
    buckets.set(key, fresh);
    return fresh;
  };

  for (const row of sorted) {
    const b = at(row.at.getTime());
    b.memUsed.push(Number(row.memTotal - row.memAvailable));
    b.memTotal = Number(row.memTotal);
    b.diskUsed.push(Number(row.diskTotal - row.diskAvailable));
    b.diskTotal = Number(row.diskTotal);
    b.runningForges = row.runningForges;
  }

  for (const interval of intervals) {
    if (!interval) continue;
    const b = at(interval.endMs);
    b.dTotal += interval.dTotal;
    b.dBusy += interval.dBusy;
    b.dIowait += interval.dIowait;
    const pct = (interval.dBusy / interval.dTotal) * 100;
    b.peakPct = b.peakPct === null ? pct : Math.max(b.peakPct, pct);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const points: UsagePoint[] = [];
  for (let key = keys[0]; key <= keys[keys.length - 1]; key += bucketMs) {
    const b = buckets.get(key);
    if (!b) {
      points.push({
        at: new Date(key).toISOString(),
        cpuPct: null, cpuPeakPct: null, iowaitPct: null,
        memUsedBytes: null, memPeakBytes: null, memTotalBytes: null,
        diskUsedBytes: null, diskTotalBytes: null, runningForges: null,
      });
      continue;
    }
    points.push({
      at: new Date(key).toISOString(),
      cpuPct: b.dTotal > 0 ? (b.dBusy / b.dTotal) * 100 : null,
      cpuPeakPct: b.peakPct,
      iowaitPct: b.dTotal > 0 ? (b.dIowait / b.dTotal) * 100 : null,
      memUsedBytes: mean(b.memUsed),
      memPeakBytes: b.memUsed.length ? Math.max(...b.memUsed) : null,
      memTotalBytes: b.memTotal,
      diskUsedBytes: mean(b.diskUsed),
      diskTotalBytes: b.diskTotal,
      runningForges: b.runningForges,
    });
  }

  // Docker: only rows that actually carry the columns, last one per bucket. No
  // null padding — a stacked area with holes in it just looks broken.
  const dockerByBucket = new Map<number, DockerPoint>();
  for (const row of sorted) {
    if (row.dockerImages === null) continue;
    const key = bucketStart(row.at.getTime(), dockerBucketMs);
    dockerByBucket.set(key, {
      at: new Date(key).toISOString(),
      imagesBytes: Number(row.dockerImages),
      containersBytes: Number(row.dockerContainers ?? 0n),
      volumesBytes: Number(row.dockerVolumes ?? 0n),
      buildCacheBytes: Number(row.dockerBuildCache ?? 0n),
    });
  }
  const docker = [...dockerByBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, point]) => point);

  const lastRow = sorted[sorted.length - 1];
  const lastInterval = [...intervals].reverse().find((i): i is NonNullable<Interval> => i !== null);
  const latest: UsageLatest = {
    at: lastRow.at.toISOString(),
    cpuPct: lastInterval ? (lastInterval.dBusy / lastInterval.dTotal) * 100 : null,
    memUsedBytes: Number(lastRow.memTotal - lastRow.memAvailable),
    memTotalBytes: Number(lastRow.memTotal),
    diskUsedBytes: Number(lastRow.diskTotal - lastRow.diskAvailable),
    diskTotalBytes: Number(lastRow.diskTotal),
    runningForges: lastRow.runningForges,
    cpuCount: lastRow.cpuCount,
  };

  return { ...base, points, docker, latest };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test lib/host/series.test.ts`
Expected: PASS, 13 tests. If the "mean and higher peak" test fails on bucket boundaries, check `bucketStart` alignment — buckets are epoch-aligned, and `T0` is midnight UTC so they line up cleanly.

- [ ] **Step 5: Commit**

```bash
git add lib/host/series.ts lib/host/series.test.ts
git commit -m "feat(usage): series derivation with reboot and gap handling"
```

---

### Task 7: Formatting, service and API route

**Files:**
- Create: `lib/host/format.ts`, `lib/host/format.test.ts`
- Create: `lib/services/usage.ts`, `lib/services/usage.test.ts`
- Create: `app/api/admin/usage/route.ts`

**Interfaces:**
- Consumes: `buildSeries`, `RANGES`, `UsageRange`, `UsageSeries` (Task 6); `env` (Task 5); `SessionUser` from `@/lib/services/types`.
- Produces: `toGiB(bytes)`, `formatGiB(bytes, digits?)`, `formatPct(pct, digits?)`, `USAGE_RANGES`, `getUsageSeries(currentUser, range): Promise<UsageSeries>`, `GET /api/admin/usage?range=…` returning `{ series }`.

- [ ] **Step 1: Write the failing formatting test**

Create `lib/host/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toGiB, formatGiB, formatPct } from './format';

describe('formatGiB', () => {
  it('formats base-1024 GiB, which reads lower than docker base-1000 GB', () => {
    // `docker system df` prints this same byte count as "52.46GB".
    expect(formatGiB(52_456_054_966)).toBe('48.9 GiB');
  });

  it('formats a whole number of GiB', () => {
    expect(formatGiB(16 * 1024 ** 3)).toBe('16.0 GiB');
  });

  it('renders an em dash for a null reading', () => {
    expect(formatGiB(null)).toBe('—');
  });

  it('honours a digits override', () => {
    expect(formatGiB(52_456_054_966, 2)).toBe('48.85 GiB');
  });
});

describe('toGiB', () => {
  it('returns a plain number for chart axes', () => {
    expect(toGiB(1024 ** 3)).toBe(1);
  });
});

describe('formatPct', () => {
  it('rounds to whole percent by default', () => {
    expect(formatPct(37.4)).toBe('37 %');
  });

  it('renders an em dash for a null reading', () => {
    expect(formatPct(null)).toBe('—');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test lib/host/format.test.ts`
Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 3: Write `lib/host/format.ts`**

```ts
const GIB = 1024 ** 3;

/** Placeholder for a bucket with no reading — a real gap, not a zero. */
export const NO_VALUE = '—';

/** Bytes to GiB as a plain number, for chart axes. */
export function toGiB(bytes: number): number {
  return bytes / GIB;
}

/**
 * Bytes as GiB (base-1024), matching `df -h` and `free -m`. Docker's own output
 * is base-1000, so the same byte count reads lower here (52.46 GB → 48.9 GiB) —
 * the unit label is what keeps that from looking like a bug.
 */
export function formatGiB(bytes: number | null, digits = 1): string {
  if (bytes === null) return NO_VALUE;
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

export function formatPct(pct: number | null, digits = 0): string {
  if (pct === null) return NO_VALUE;
  return `${pct.toFixed(digits)} %`;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm test lib/host/format.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing service test**

Create `lib/services/usage.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser } from '@/lib/test/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { getUsageSeries } from './usage';
import type { UsageRange } from '@/lib/host/series';

const SAMPLE = {
  cpuJiffiesTotal: 0n,
  cpuJiffiesIdle: 0n,
  cpuJiffiesIowait: 0n,
  cpuCount: 1,
  memTotal: 16_000_000_000n,
  memAvailable: 8_000_000_000n,
  diskTotal: 250_000_000_000n,
  diskAvailable: 125_000_000_000n,
  dockerImages: null,
  dockerContainers: null,
  dockerVolumes: null,
  dockerBuildCache: null,
  runningForges: 1,
};

describe('getUsageSeries', () => {
  it('refuses a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(getUsageSeries(dev, '24h')).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('rejects an unknown range', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(getUsageSeries(admin, 'forever' as UsageRange)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('returns an empty series for an admin when nothing has been sampled', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const series = await getUsageSeries(admin, '24h');
      expect(series).toMatchObject({ range: '24h', points: [], latest: null });
    });
  });

  it('includes rows inside the window and excludes older ones', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const now = Date.now();
      await prisma.hostSample.create({ data: { ...SAMPLE, at: new Date(now - 30 * 60_000) } });
      await prisma.hostSample.create({
        data: { ...SAMPLE, at: new Date(now - 40 * 60 * 60_000) }, // 40 h ago
      });
      const series = await getUsageSeries(admin, '24h');
      expect(series.latest).not.toBeNull();
      // Only the recent sample is in range, so exactly one bucket is emitted.
      expect(series.points).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm test lib/services/usage.test.ts`
Expected: FAIL — cannot resolve `./usage`.

- [ ] **Step 7: Write `lib/services/usage.ts`**

```ts
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { buildSeries, RANGES, type UsageRange, type UsageSeries } from '@/lib/host/series';
import type { SessionUser } from './types';

export const USAGE_RANGES = Object.keys(RANGES) as UsageRange[];

/** Fallback cadence for gap detection when the sampler is disabled (e2e). */
const DEFAULT_SAMPLE_INTERVAL_MS = 300_000;

export async function getUsageSeries(
  currentUser: SessionUser,
  range: UsageRange,
): Promise<UsageSeries> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const spec = RANGES[range];
  if (!spec) {
    throw new ValidationError('Unknown range', {
      range: [`Must be one of ${USAGE_RANGES.join(', ')}`],
    });
  }

  const rows = await prisma.hostSample.findMany({
    where: { at: { gte: new Date(Date.now() - spec.windowMs) } },
    orderBy: { at: 'asc' },
  });

  return buildSeries(rows, {
    range,
    sampleIntervalMs: env.FORGE_USAGE_SAMPLE_MS || DEFAULT_SAMPLE_INTERVAL_MS,
  });
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `pnpm test lib/services/usage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Write the route handler**

Create `app/api/admin/usage/route.ts`, mirroring `app/api/admin/groups/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getUsageSeries } from '@/lib/services/usage';
import { respondToServiceError } from '@/lib/http';

const RangeParam = z.enum(['24h', '7d', '30d', '90d']).default('30d');

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const raw = new URL(req.url).searchParams.get('range');
  const parsed = RangeParam.safeParse(raw ?? undefined);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }
  try {
    const series = await getUsageSeries(session.user, parsed.data);
    return NextResponse.json({ series });
  } catch (err) {
    return respondToServiceError(err);
  }
}
```

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

```bash
git add lib/host/format.ts lib/host/format.test.ts lib/services/usage.ts lib/services/usage.test.ts app/api/admin/usage
git commit -m "feat(usage): formatting helpers, usage service and API route"
```

---

### Task 8: The /admin/usage page

**Files:**
- Modify: `package.json` (add Recharts)
- Create: `app/(app)/admin/usage/page.tsx`
- Create: `app/(app)/admin/usage/charts.tsx`
- Create: `app/(app)/admin/usage/UsageClient.tsx`
- Create: `app/(app)/admin/usage/UsageClient.test.tsx`
- Modify: `app/(app)/admin/AdminNav.tsx:6`
- Modify: `app/(app)/admin/AdminNav.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/usage` returning `{ series: UsageSeries }` (Task 7); `formatGiB`, `formatPct`, `toGiB` (Task 7); `UsageSeries`, `UsagePoint`, `DockerPoint` types (Task 6).
- Produces: the page. Nothing later depends on it.

- [ ] **Step 1: Install Recharts**

Run: `pnpm add recharts@3.10.1`
Expected: `package.json` gains `"recharts": "3.10.1"`. It lists React 19 in its peer dependencies, so no `--force` is needed. Pin the exact version.

- [ ] **Step 2: Load the dataviz skill before writing any chart code**

The spec deliberately leaves chart form and palette to implementation time. Load the `dataviz` skill now and follow it for chart type selection, colour assignment, axis and tooltip treatment. The structure below is fixed by the spec; the visual specifics are the skill's call.

- [ ] **Step 3: Write the failing nav test**

Add to `app/(app)/admin/AdminNav.test.tsx` (inside the existing `describe('AdminNav')`):

```ts
  it('links Usage in both modes', () => {
    const { unmount } = render(<AdminNav prodMode={false} />);
    expect(screen.getByRole('link', { name: /usage/i })).toHaveAttribute('href', '/admin/usage');
    unmount();
    render(<AdminNav prodMode />);
    expect(screen.getByRole('link', { name: /usage/i })).toHaveAttribute('href', '/admin/usage');
  });
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm test app/\(app\)/admin/AdminNav.test.tsx`
Expected: FAIL — no link named "Usage".

- [ ] **Step 5: Add the nav item**

In `app/(app)/admin/AdminNav.tsx`, extend `BASE_ITEMS`:

```ts
const BASE_ITEMS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/groups', label: 'Groups' },
  // Mode-independent: each dashboard samples the host it runs on, so prod gets
  // this page too.
  { href: '/admin/usage', label: 'Usage' },
];
```

- [ ] **Step 6: Run the nav test and confirm it passes**

Run: `pnpm test app/\(app\)/admin/AdminNav.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 7: Write `charts.tsx`**

Colours are constants mirroring `@theme` in `app/globals.css` rather than CSS-variable reads. **This is a deliberate narrowing of the spec**, which said to read the variables: SVG presentation attributes do not resolve `var()`, so honouring it literally would mean a `getComputedStyle` hook for a dark-only palette. Keep the sync comment so a palette change is findable.

```tsx
'use client';

import {
  Area, AreaChart, CartesianGrid, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { DockerPoint, UsagePoint } from '@/lib/host/series';
import { formatGiB, formatPct, toGiB } from '@/lib/host/format';

// Mirrors the @theme block in app/globals.css. SVG presentation attributes do
// not resolve var(), so these are literals — keep them in step with the tokens.
const COLORS = {
  cpu: '#B9A060',       // --color-gold
  peak: '#d4be7e',      // --color-gold-soft
  iowait: '#8c7747',    // --color-gold-deep
  mem: '#4ad28b',       // --color-good
  disk: '#9aa7b6',      // --color-ink-dim
  capacity: '#d96868',  // --color-danger
  grid: 'rgba(255,255,255,0.08)',
  axis: '#5d6b7d',      // --color-ink-faint
};
```

Then export one component per chart — `CpuChart`, `MemoryChart`, `DiskChart`, `DockerChart` — each taking its points array plus the shared time formatter, and a `UsageCharts` wrapper that stacks the four. Follow the dataviz skill for the specifics. Requirements the spec fixes:

- CPU: mean as an area, peak as a line, iowait as a second band. Y axis 0–100, `formatPct` on the tooltip.
- Memory: used as an area, peak as a line, `memTotalBytes` as a `ReferenceLine` so headroom is visible. `formatGiB` on the tooltip, `toGiB` on the axis.
- Disk: used as an area against a `diskTotalBytes` `ReferenceLine`.
- Docker: stacked areas — images, volumes, build cache, containers.
- Every chart: `connectNulls` **must stay false** (the default) — nulls are real gaps, and joining them would draw a line through a reboot or an outage.
- Every chart wrapped in `<ResponsiveContainer>` inside a fixed-height parent, and inside an `overflow-x-auto` container so a narrow viewport scrolls the chart rather than the page.

- [ ] **Step 8: Write the failing client test**

Create `app/(app)/admin/usage/UsageClient.test.tsx`. Note it mocks `./charts`, not `recharts` — jsdom has no layout, so `ResponsiveContainer` renders nothing, and the arithmetic worth testing already lives in `series.ts`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageClient } from './UsageClient';

vi.mock('./charts', () => ({
  UsageCharts: () => <div data-testid="usage-charts" />,
}));

const SERIES = {
  range: '30d',
  bucketMs: 14_400_000,
  dockerBucketMs: 1_800_000,
  points: [{
    at: '2026-09-01T00:00:00.000Z',
    cpuPct: 37.4, cpuPeakPct: 91, iowaitPct: 4,
    memUsedBytes: 10_000_000_000, memPeakBytes: 12_000_000_000, memTotalBytes: 16_766_013_440,
    diskUsedBytes: 130_000_000_000, diskTotalBytes: 268_315_004_928, runningForges: 3,
  }],
  docker: [],
  latest: {
    at: '2026-09-01T00:00:00.000Z',
    cpuPct: 37.4,
    memUsedBytes: 10_000_000_000,
    memTotalBytes: 16_766_013_440,
    diskUsedBytes: 130_000_000_000,
    diskTotalBytes: 268_315_004_928,
    runningForges: 3,
    cpuCount: 1,
  },
};

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

beforeEach(() => { vi.stubGlobal('fetch', mockFetch({ series: SERIES })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('UsageClient', () => {
  it('requests the 30 day range by default and renders the tiles', async () => {
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByTestId('usage-charts')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith('/api/admin/usage?range=30d');
    expect(screen.getByText('37 %')).toBeInTheDocument();
    expect(screen.getByText(/9\.3 GiB/)).toBeInTheDocument();   // 10e9 bytes
    expect(screen.getByText(/121\.1 GiB/)).toBeInTheDocument(); // 130e9 bytes
    expect(screen.getByTestId('tile-forges')).toHaveTextContent('3');
  });

  it('refetches when the range changes', async () => {
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByTestId('usage-charts')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '24h' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/admin/usage?range=24h'),
    );
  });

  it('shows a collecting message when nothing has been sampled yet', async () => {
    vi.stubGlobal('fetch', mockFetch({ series: { ...SERIES, points: [], docker: [], latest: null } }));
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByText(/collecting/i)).toBeInTheDocument());
    expect(screen.queryByTestId('usage-charts')).not.toBeInTheDocument();
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Admin only' }, false));
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 9: Run it and confirm it fails**

Run: `pnpm test app/\(app\)/admin/usage/UsageClient.test.tsx`
Expected: FAIL — cannot resolve `./UsageClient`.

- [ ] **Step 10: Write `UsageClient.tsx`**

A `'use client'` component holding:

- `useState` for `range` (default `'30d'`), `series`, `loading`, `error`.
- A `useCallback` loader hitting `/api/admin/usage?range=${range}` — `fetch` called with exactly that single-argument shape, since the test asserts it — setting `error` when `!res.ok`, and a `useEffect` that runs it on mount and whenever `range` changes, guarded by a `cancelled` ref like `PromotionsClient.tsx:37-56`.
- **No polling.** Live diagnosis is out of scope; a manual "Refresh" button calls the same loader.
- A range switcher rendering four `<button>`s labelled exactly `24h`, `7d`, `30d`, `90d`, the active one styled `bg-panel text-ink` and the rest `text-ink-dim` (matching `AdminNav`'s convention).
- Four tiles from `series.latest`, each carrying a `data-testid` (`tile-cpu`, `tile-memory`, `tile-disk`, `tile-forges`) — both the unit test and the e2e spec address them that way: `formatPct(latest.cpuPct)` with a `{latest.cpuCount} vCPU` caption; `formatGiB(latest.memUsedBytes)` captioned `of {formatGiB(latest.memTotalBytes)} — total minus available`; `formatGiB(latest.diskUsedBytes)` captioned `of {formatGiB(latest.diskTotalBytes)}`; and `latest.runningForges` captioned `running forges`.
- States, in this order: `error` → `Could not load usage data.`; `loading && !series` → a skeleton; `series.latest === null` → `Collecting — first samples appear within 5 minutes.`; otherwise the tiles plus `<UsageCharts …/>`.
- Layout `className="mx-auto flex max-w-5xl flex-col gap-6 p-6"`, matching the other admin pages' single-column feel.

The memory tile caption must say the number is total minus available — the Global Constraints require it, because it will not match `free`'s "used".

- [ ] **Step 11: Run the client test and confirm it passes**

Run: `pnpm test app/\(app\)/admin/usage/UsageClient.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 12: Write the page**

Create `app/(app)/admin/usage/page.tsx`:

```tsx
import { UsageClient } from './UsageClient';

// Always fresh: the series changes every 5 minutes and must never be cached.
export const dynamic = 'force-dynamic';

export default function AdminUsagePage() {
  return <UsageClient />;
}
```

No `isProdMode()` / `notFound()` gate — unlike promotions and deployments, this page is valid in both modes.

- [ ] **Step 13: Build and look at it**

Run: `pnpm build`
Expected: clean; note the `/admin/usage` route's JS size in the output for the record.

Then start the dev server, log in as an admin, and open `/admin/usage`. Confirm: four tiles populated, four charts drawn, the range switcher refetches, and — if fewer than two samples exist yet — the collecting message rather than an empty axis.

- [ ] **Step 14: Commit**

```bash
git add package.json pnpm-lock.yaml "app/(app)/admin/usage" "app/(app)/admin/AdminNav.tsx" "app/(app)/admin/AdminNav.test.tsx"
git commit -m "feat(usage): /admin/usage page with CPU, memory, disk and docker charts"
```

---

### Task 9: Seeded history and e2e coverage

**Files:**
- Modify: `prisma/seed.ts`
- Modify: `scripts/e2e.sh` (final `exec` line)
- Modify: `playwright.config.ts:32-45` (`webServer.env`)
- Create: `tests/e2e/usage.spec.ts`

**Interfaces:**
- Consumes: the `HostSample` table (Task 1), the page and its tile testids (Task 8), the API route (Task 7).
- Produces: `FORGE_SEED_USAGE=1` as the switch that generates 48 h of synthetic samples.

**Why gated.** The sampler would otherwise run for real under e2e (`instrumentation.ts` only skips `NODE_ENV === 'test'`), and waiting 5 minutes for a first sample is not a test. Equally, the seed must **not** generate these rows unconditionally: this working tree is the live pilot, and a populated-looking chart made of fake history is worse than an empty one.

- [ ] **Step 1: Add the gated seed block to `prisma/seed.ts`**

Add this function above `main()`:

```ts
/**
 * 48 h of synthetic HostSample rows, so /admin/usage has something to draw in
 * e2e and on a fresh local instance. Gated on FORGE_SEED_USAGE=1 — never
 * generate fake history into the pilot's live database.
 */
async function seedUsageSamples(): Promise<void> {
  const INTERVAL_MS = 300_000;
  const COUNT = 576; // 48 h at 5-minute samples
  const DOCKER_EVERY = 6; // 30 min, matching DOCKER_SAMPLE_INTERVAL_MS
  const start = Date.now() - COUNT * INTERVAL_MS;

  // Counters are cumulative, exactly as the sampler stores them.
  let cumTotal = 0n;
  let cumIdle = 0n;
  let cumIowait = 0n;

  const rows = [];
  for (let i = 0; i < COUNT; i += 1) {
    // A daily swell between ~20 % and ~45 % busy, so the chart has shape.
    const busyFrac = 0.2 + 0.25 * Math.abs(Math.sin((i / 288) * Math.PI * 2));
    const perInterval = 30_000n; // 1 vCPU at 100 Hz for 5 minutes
    const busy = BigInt(Math.round(30_000 * busyFrac));
    cumTotal += perInterval;
    cumIdle += perInterval - busy;
    cumIowait += busy / 5n;

    const withDocker = i % DOCKER_EVERY === 0;
    const growth = BigInt(i) * 2_000_000n; // disk and images creep upward
    rows.push({
      at: new Date(start + i * INTERVAL_MS),
      cpuJiffiesTotal: cumTotal,
      cpuJiffiesIdle: cumIdle,
      cpuJiffiesIowait: cumIowait,
      cpuCount: 1,
      memTotal: 16_766_013_440n,
      memAvailable: 6_661_554_176n - BigInt(Math.round(500_000_000 * busyFrac)),
      diskTotal: 268_315_004_928n,
      diskAvailable: 130_000_000_000n - growth,
      dockerImages: withDocker ? 23_135_864_692n + growth : null,
      dockerContainers: withDocker ? 1_560_223_744n : null,
      dockerVolumes: withDocker ? 25_503_138_118n : null,
      dockerBuildCache: withDocker ? 52_456_054_966n + growth : null,
      runningForges: withDocker ? 2 : null,
    });
  }

  await prisma.hostSample.createMany({ data: rows });
  console.log(`🖥️  Seeded ${rows.length} synthetic HostSample rows.`);
}
```

And call it near the end of `main()`, immediately before the `console.log('✅ Seed complete.')` line:

```ts
  if (process.env.FORGE_SEED_USAGE === '1') await seedUsageSamples();
```

- [ ] **Step 2: Verify the seed against the test database only**

Run: `pnpm test lib/services/usage.test.ts`
Expected: still PASS — `withCleanDb` truncates `HostSample`, so seeded rows cannot leak into service assertions. Do **not** run `pnpm db:seed` by hand.

- [ ] **Step 3: Pass the switches through the e2e harness**

In `scripts/e2e.sh`, change the final command to:

```sh
DATABASE_URL="$E2E_DATABASE_URL" E2E_PORT="$PORT" FORGE_SEED_USAGE=1 \
  exec pnpm exec playwright test "${ARGS[@]}"
```

In `playwright.config.ts`, add to `webServer.env`:

```ts
      // The sampler would otherwise write real rows during the suite; the seed
      // supplies deterministic history instead.
      FORGE_USAGE_SAMPLE_MS: '0',
```

- [ ] **Step 4: Write the e2e spec**

Create `tests/e2e/usage.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

const SEED_USERS = {
  admin: 'admin@crystalfountains.com',
  maya: 'maya.chen@crystalfountains.com',
};

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('an admin sees host usage charted from the seeded history', async ({ page }) => {
  await devLogin(page, SEED_USERS.admin);
  await page.goto('/admin/users');
  await page.getByRole('link', { name: /usage/i }).click();

  await expect(page.getByTestId('tile-cpu')).toBeVisible();
  await expect(page.getByTestId('tile-memory')).toContainText('GiB');
  await expect(page.getByTestId('tile-disk')).toContainText('GiB');
  await expect(page.getByTestId('tile-forges')).toContainText('2');
  await expect(page.getByText(/collecting/i)).toHaveCount(0);

  await page.getByRole('button', { name: '24h' }).click();
  await expect(page.getByTestId('tile-cpu')).toBeVisible();
});

test('a non-admin cannot read the usage API', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  const res = await page.request.get('/api/admin/usage?range=24h');
  expect(res.status()).toBe(403);
});
```

- [ ] **Step 5: Run the e2e suite**

Run: `./scripts/e2e.sh usage.spec.ts`
On the pilot this refuses because the live service is up and `:80` is in use — that guard is about the *database*, which is isolated either way, so re-run as:
Run: `./scripts/e2e.sh --i-understand-this-seeds-the-db usage.spec.ts`
Expected: both tests pass. If the first fails on an empty page, check that `FORGE_SEED_USAGE=1` actually reached `prisma/seed.ts` — the seed prints `🖥️  Seeded 576 synthetic HostSample rows.`

- [ ] **Step 6: Run the full e2e suite once, to catch collateral damage**

Run: `./scripts/e2e.sh --i-understand-this-seeds-the-db`
Expected: all specs pass.

- [ ] **Step 7: Commit**

```bash
git add prisma/seed.ts scripts/e2e.sh playwright.config.ts tests/e2e/usage.spec.ts
git commit -m "test(e2e): seeded usage history and /admin/usage coverage"
```

---

### Task 10: Full verification, documentation and pilot rollout

**Files:**
- Modify: `AGENTS.md` (one bullet in "Conventions & gotchas")

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the whole suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean. `🌱 The seed command has been executed` in the test output is expected and does not touch the dev database.

- [ ] **Step 2: Document the two non-obvious constraints in `AGENTS.md`**

Add to the "Conventions & gotchas" list:

```markdown
- **`docker system df` costs ~17 s on the pilot host**, because the daemon walks
  every image, volume and build-cache record (145 / 32 / 1128 as of 2026-09-02).
  Only the daemon socket (`GET /system/df`) returns exact bytes — `--format json`
  hangs and `--format '{{json .}}'` emits human strings like `"23.14GB"`.
  `ContainerManager.diskUsage()` wraps it, and the usage sampler calls it every
  30 min, never on every tick. Anything else that wants docker's disk figures
  must respect that budget.
- **`/admin/usage` stores raw cumulative CPU jiffies, not percentages.** Every
  rate is derived between consecutive rows in `lib/host/series.ts`, which is why
  a missed sample reads as a longer average rather than a spike, and a reboot
  (the counter going backwards) reads as a gap. Memory "used" is
  `MemTotal - MemAvailable` and will not match `free`'s used column; disk free is
  `bavail`, not `bfree`; and the page labels everything GiB (base-1024), so its
  docker figures read lower than `docker system df`'s base-1000 output.
```

- [ ] **Step 3: Commit the docs**

```bash
git add AGENTS.md
git commit -m "docs: record the docker df cost and the usage sampler's invariants"
```

- [ ] **Step 4: Migrate the live pilot database**

This repo *is* the live pilot, so the feature is not real until the live database has the table.

Run: `pnpm db:migrate`
Expected: reports the migration already applied (Task 1 created it here) — or applies it if the plan was executed in a worktree.

- [ ] **Step 5: Restart the dashboard service**

Run: `sudo systemctl restart crystal-forge.service`
Expected: the unit rebuilds (1–2 min, during which the dashboard is down) and comes back.

Run: `journalctl -u crystal-forge.service -n 40 --no-pager | grep -i usage`
Expected: `[instrumentation] host usage sampler started`.

- [ ] **Step 6: Confirm real samples are landing**

Run: `docker exec crystal-forge-pg psql -U postgres -d crystal_forge -c 'select count(*), min(at), max(at) from "HostSample";'`
Expected: at least one row immediately, a second about 5 minutes later.

Run: `docker exec crystal-forge-pg psql -U postgres -d crystal_forge -c 'select at, "dockerBuildCache", "runningForges" from "HostSample" order by at desc limit 8;'`
Expected: docker columns populated on roughly every 6th row, null in between; `runningForges` matching `docker ps --filter label=crystal-forge.forgeId --filter status=running -q | wc -l`.

- [ ] **Step 7: Look at the live page**

Open `/admin/usage` on the pilot as an admin. Confirm the four tiles read plausibly against `free -m`, `df -h /` and `docker system df`, remembering that memory "used" is total-minus-available and that the docker figures are GiB against docker's GB. With under two samples the page must show the collecting message, not a broken chart.

- [ ] **Step 8: Report completion honestly**

State which commands were run and their real output. If the docker breakdown has not yet been sampled twice (it needs an hour for two points), say so rather than implying the docker chart was verified with a trend.

## Self-Review Notes

Checked against the spec, 2026-09-02:

- **Spec coverage:** data model → Task 1; parsers and readers → Tasks 2, 4; docker socket access → Task 3; cadence, guards, retention, env, boot wiring → Task 5; bucketing, gaps, reboots, mean/peak, docker sub-bucketing → Task 6; admin gate, route, units → Task 7; nav, page, tiles, charts, empty states, no auto-refresh → Task 8; seeded history and e2e → Task 9; rollout → Task 10.
- **Deliberate deviation:** the spec said chart colours would be read from token CSS variables. Task 8 uses literal constants mirroring `@theme` instead, because SVG presentation attributes do not resolve `var()` and the palette is dark-only. Recorded in the task.
- **Not built, per the spec's Deferred section:** per-forge attribution, alerting, two-tier retention, SQL-side bucketing (revisit past ~105 k rows).
