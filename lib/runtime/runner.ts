import { loadState, mutateState } from './state';
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
  now?: () => Date;
  startingTimeoutMs?: number;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? 60_000;

  // Non-destructive: only the status changes. The container is NEVER removed
  // here. An active forge survives dev-server hiccups (the in-container
  // supervisor restarts `pnpm dev`), and a genuinely dead container is left in
  // place so its logs are inspectable and the forge is recoverable. Removal
  // happens only on explicit stopForge.
  async function markCrashed(forgeId: string) {
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = 'crashed'; });
  }

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) await markCrashed(entry.forgeId);
        continue;
      }
      if (entry.status !== 'running') continue;
      // A failed HTTP probe is NOT a crash signal — the supervisor restarts the
      // dev server on its own. Only a dead container means the forge is down.
      const running = entry.containerId
        ? (await mgr.inspect(entry.containerId)).running
        : false;
      if (!running) await markCrashed(entry.forgeId);
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
