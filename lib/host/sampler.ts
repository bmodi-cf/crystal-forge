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
