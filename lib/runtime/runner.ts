import { loadState, mutateState } from './state';
import { probe as defaultProbe } from './probe';
import { getContainerManager } from './container';
import type { ContainerManager } from './container/types';

const FORGE_LABEL = 'crystal-forge.forgeId';

export type BootCleanupDeps = { containerManager?: ContainerManager };

export async function bootCleanup(deps: BootCleanupDeps = {}): Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const containers = await mgr.list({ label: FORGE_LABEL });
  for (const c of containers) {
    try { await mgr.remove(c.id); }
    catch (err) { console.error('[runtime/bootCleanup] remove failed', { id: c.id, err }); }
  }
  await mutateState((s) => { for (const k of Object.keys(s)) delete s[k]; });
}

export type LivenessDeps = {
  containerManager?: ContainerManager;
  probe?: (port: number) => Promise<boolean>;
  now?: () => Date;
  startingTimeoutMs?: number;
  failureThreshold?: number;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const probe = deps.probe ?? defaultProbe;
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? 60_000;
  const failureThreshold = deps.failureThreshold ?? 3;
  const failureCounts = new Map<string, number>();

  async function markCrashed(forgeId: string, containerId: string) {
    if (containerId) await mgr.remove(containerId).catch(() => {});
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = 'crashed'; });
  }

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) await markCrashed(entry.forgeId, entry.containerId);
        continue;
      }
      if (entry.status !== 'running') continue;
      const alive = (await mgr.inspect(entry.containerId)).running;
      const healthy = alive && await probe(entry.port);
      if (healthy) { failureCounts.delete(entry.forgeId); continue; }
      const next = (failureCounts.get(entry.forgeId) ?? 0) + 1;
      failureCounts.set(entry.forgeId, next);
      if (!alive || next >= failureThreshold) {
        failureCounts.delete(entry.forgeId);
        await markCrashed(entry.forgeId, entry.containerId);
      }
    }
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startLivenessLoop(deps: LivenessDeps = {}, intervalMs = 5000): { stop: () => void } {
  if (intervalHandle) clearInterval(intervalHandle);
  const check = makeLivenessChecker(deps);
  intervalHandle = setInterval(() => {
    void check().catch((err) => console.error('[runtime/runner] check failed', err));
  }, intervalMs);
  intervalHandle.unref?.();
  return {
    stop: () => {
      if (intervalHandle) clearInterval(intervalHandle);
      intervalHandle = null;
    },
  };
}
