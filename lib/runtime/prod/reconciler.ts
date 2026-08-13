import type { PrismaClient } from '@prisma/client';
import type { ContainerManager } from '@/lib/runtime/container/types';
import { mutateState } from '@/lib/runtime/state';
import { logPath } from '@/lib/runtime/paths';
import { listDesiredForges, type DesiredForge } from './desired-state';
import { saveDeploymentStatuses } from './deployment-status';

export type DeploymentPhase = 'running' | 'failed' | 'stopped';

export type DeploymentStatus = {
  forgeId: string;
  slug: string;
  name: string;
  desiredVersion: string;
  runningVersion: string | null;
  phase: DeploymentPhase;
  error: string | null;
  consecutiveFailures: number;
};

export type ReconcilerDeps = {
  prisma: PrismaClient;
  containerManager: ContainerManager;
  start: (input: DesiredForge) => Promise<{ containerId: string; port: number }>;
  stop: (containerId: string) => Promise<void>;
  maxFailures?: number;
  now?: () => Date;
};

const DEFAULT_MAX_FAILURES = 3;

type Actual = { id: string; version: string | null; port: number | null };
type FailRecord = { count: number; version: string; error: string };

export function makeReconciler(deps: ReconcilerDeps) {
  const maxFailures = deps.maxFailures ?? DEFAULT_MAX_FAILURES;
  const now = deps.now ?? (() => new Date());
  // Persisted across ticks (same process): per-forge consecutive failures.
  const failures = new Map<string, FailRecord>();
  let lastStatuses: DeploymentStatus[] = [];

  async function reconcileOnce(): Promise<void> {
    const desired = await listDesiredForges(deps.prisma);
    const summaries = await deps.containerManager.list({ label: 'crystal-forge.forgeId' });

    // Map actual containers by forgeId (id comes from the summary, not a label).
    const actualByForge = new Map<string, Actual>();
    for (const s of summaries) {
      const forgeId = s.labels['crystal-forge.forgeId'];
      if (!forgeId) continue;
      actualByForge.set(forgeId, {
        id: s.id,
        version: s.labels['crystal-forge.version'] ?? null,
        port: s.labels['crystal-forge.port'] ? Number(s.labels['crystal-forge.port']) : null,
      });
    }

    const desiredIds = new Set(desired.map((d) => d.forgeId));
    const statuses: DeploymentStatus[] = [];

    // 1) Reconcile every desired forge.
    for (const d of desired) {
      const actual = actualByForge.get(d.forgeId);
      const running = actual ? (await deps.containerManager.inspect(actual.id)).running : false;
      const versionMatches = actual?.version === d.deployVersion;

      // No-op: correct version and up. Adopt (ensure state entry) + clear failures.
      if (actual && versionMatches && running) {
        failures.delete(d.forgeId);
        await writeRunning(d, actual.id, actual.port ?? 0);
        statuses.push(status(d, d.deployVersion, 'running', null));
        continue;
      }

      // Backoff: capped for this exact version -> do not retry. Report the last
      // real error so the admin sees WHY it failed, not a generic message.
      const fail = failures.get(d.forgeId);
      if (fail && fail.version === d.deployVersion && fail.count >= maxFailures) {
        statuses.push(status(d, actual?.version ?? null, 'failed', fail.error, fail.count));
        continue;
      }

      // Wrong version or crashed: tear down the old container first.
      if (actual) {
        await deps.stop(actual.id);
        await removeState(d.forgeId);
      }

      // (Re)start.
      try {
        const { containerId, port } = await deps.start(d);
        failures.delete(d.forgeId);
        await writeRunning(d, containerId, port);
        statuses.push(status(d, d.deployVersion, 'running', null));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const prev = failures.get(d.forgeId);
        const count = prev && prev.version === d.deployVersion ? prev.count + 1 : 1;
        failures.set(d.forgeId, { count, version: d.deployVersion, error: message });
        await removeState(d.forgeId);
        console.error('[reconciler] failed forgeId=%s slug=%s version=%s: %s', d.forgeId, d.slug, d.deployVersion, message);
        statuses.push(status(d, null, 'failed', message, count));
      }
    }

    // 2) Remove containers whose forge is no longer desired.
    for (const [forgeId, actual] of actualByForge) {
      if (desiredIds.has(forgeId)) continue;
      await deps.stop(actual.id);
      await removeState(forgeId);
      failures.delete(forgeId);
    }

    lastStatuses = statuses;
  }

  async function writeRunning(d: DesiredForge, containerId: string, port: number): Promise<void> {
    await mutateState((s) => {
      s[d.forgeId] = {
        forgeId: d.forgeId,
        slug: d.slug,
        status: 'running',
        containerId,
        port,
        startedAt: now().toISOString(),
        logPath: logPath(d.slug),
      };
    });
  }

  async function removeState(forgeId: string): Promise<void> {
    await mutateState((s) => { delete s[forgeId]; });
  }

  function status(
    d: DesiredForge,
    runningVersion: string | null,
    phase: DeploymentPhase,
    error: string | null,
    consecutiveFailures = 0,
  ): DeploymentStatus {
    return {
      forgeId: d.forgeId, slug: d.slug, name: d.name,
      desiredVersion: d.deployVersion, runningVersion, phase, error, consecutiveFailures,
    };
  }

  return {
    reconcileOnce,
    statuses: () => lastStatuses,
  };
}

/**
 * Start the declarative reconcile loop: one tick immediately, then every
 * intervalMs. An in-flight guard skips a tick if the previous is still applying
 * so a slow image pull cannot stack reconciles.
 */
export function startReconcileLoop(deps: ReconcilerDeps, intervalMs: number): { stop: () => void } {
  const rec = makeReconciler(deps);
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await rec.reconcileOnce();
      await saveDeploymentStatuses(rec.statuses());
    } catch (err) {
      console.error('[reconciler] tick failed', err);
    } finally {
      inFlight = false;
    }
  }

  void tick();
  const handle = setInterval(() => { void tick(); }, intervalMs);
  return { stop: () => clearInterval(handle) };
}
