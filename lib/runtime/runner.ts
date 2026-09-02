import { loadState, mutateState, saveState } from './state';
import { getContainerManager } from './container';
import type { ContainerManager } from './container/types';
import { logPath } from './paths';
import { probe as defaultProbe, STARTING_TIMEOUT_MS } from './probe';
import type { RuntimeStateFile } from './types';

export const FORGE_LABEL = 'crystal-forge.forgeId';

/**
 * DB-backed lookup used only when adopting a running container that has no
 * state entry. Returns the forge's slug + repo, or null if the forge no longer
 * exists (deleted). The DB is the canonical source — the `forge-<slug>`
 * container name is not trusted for this.
 */
export type ForgeLookup = (
  forgeId: string,
) => Promise<{ slug: string; repoFullName: string } | null>;

export type ReconcileDeps = {
  containerManager?: ContainerManager;
  forgeLookup?: ForgeLookup;
  now?: () => Date;
};

/**
 * Reconcile persisted runtime state against what Docker actually has, treating
 * Docker as the source of truth. Replaces the old destroy-everything
 * bootCleanup: forge containers that survived the dashboard going away are
 * adopted back as `running` (and become reachable via the file-backed
 * proxy/HMR lookups), while genuinely-dead containers and stale state entries
 * are cleaned up. Runs in register() before the server serves and before any
 * new forge start, so adopted ports are recorded first and allocatePort cannot
 * collide with them.
 */
export async function reconcileForges(deps: ReconcileDeps = {}): Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const forgeLookup = deps.forgeLookup ?? (async () => null);
  const now = deps.now ?? (() => new Date());

  const safeRemove = async (id: string) => {
    try { await mgr.remove(id); }
    catch (err) { console.error('[runtime/reconcileForges] remove failed', { id, err }); }
  };

  const containers = await mgr.list({ label: FORGE_LABEL });
  const state = await loadState();

  // Build the reconciled file from scratch: any state entry not re-added below
  // (i.e. whose forgeId matches no surviving running container) is dropped.
  const reconciled: RuntimeStateFile = {};

  for (const c of containers) {
    const forgeId = c.labels[FORGE_LABEL];
    if (!forgeId) continue; // labelled but value missing — nothing to key on

    const status = await mgr.inspect(c.id);

    // Not running → exited leftover. Remove it; drop any matching entry.
    if (!status.running) {
      await safeRemove(c.id);
      continue;
    }

    const existing = state[forgeId];
    if (existing) {
      // Keep the entry; Docker is the source of truth for containerId + status.
      // Port stays from the entry (inspect isn't consulted for it here).
      reconciled[forgeId] = { ...existing, containerId: c.id, status: 'running' };
      continue;
    }

    // Running but no entry (state lost/corrupt/wiped) → adopt from the DB.
    const looked = await forgeLookup(forgeId);
    if (!looked) {
      // Forge deleted — cannot safely serve an unknown forge.
      await safeRemove(c.id);
      continue;
    }
    reconciled[forgeId] = {
      forgeId,
      slug: looked.slug,
      repoFullName: looked.repoFullName,
      status: 'running',
      containerId: c.id,
      port: status.port ?? 0,
      startedAt: now().toISOString(),
      logPath: logPath(looked.slug),
    };
  }

  await saveState(reconciled);
}

export type LivenessDeps = {
  containerManager?: ContainerManager;
  now?: () => Date;
  startingTimeoutMs?: number;
  probe?: (port: number) => Promise<boolean>;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const mgr = deps.containerManager ?? getContainerManager();
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? STARTING_TIMEOUT_MS;
  const probeFn = deps.probe ?? defaultProbe;

  // Non-destructive: only the status changes. The container is NEVER removed
  // here. An active forge survives dev-server hiccups (the in-container
  // supervisor restarts `pnpm dev`), and a genuinely dead container is left in
  // place so its logs are inspectable and the forge is recoverable. Removal
  // happens only on explicit stopForge.
  async function setStatus(forgeId: string, status: 'crashed' | 'running') {
    await mutateState((s) => { const e = s[forgeId]; if (e) e.status = status; });
  }

  const isRunning = async (containerId: string | undefined) =>
    containerId ? (await mgr.inspect(containerId)).running : false;

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) await setStatus(entry.forgeId, 'crashed');
        continue;
      }

      // `crashed` is a report, not a verdict. finishStart records it when the
      // probe deadline expires but deliberately keeps the container, so on a
      // loaded host this is routinely a dev server that simply hadn't bound its
      // port yet — the in-container supervisor is still working. Re-probe so
      // such a forge heals itself; otherwise the status is permanent (nothing
      // else revisits it) and the only recovery is a manual restart that throws
      // away a container which had, by then, come up fine.
      if (entry.status === 'crashed') {
        if (!(await isRunning(entry.containerId))) continue;
        if (await probeFn(entry.port)) await setStatus(entry.forgeId, 'running');
        continue;
      }

      // `setup-failed` is genuinely terminal (the workspace never got built),
      // and `stopping` is someone else's transition — leave both alone.
      if (entry.status !== 'running') continue;

      // A failed HTTP probe is NOT a crash signal — the supervisor restarts the
      // dev server on its own. Only a dead container means the forge is down.
      if (!(await isRunning(entry.containerId))) await setStatus(entry.forgeId, 'crashed');
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
