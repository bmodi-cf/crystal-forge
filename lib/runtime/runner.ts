import { loadState, mutateState } from './state';
import { isAlive as defaultIsAlive, killProcess as defaultKill } from './process';
import { probe as defaultProbe } from './probe';

export type BootCleanupDeps = {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<void>;
};

export async function bootCleanup(deps: BootCleanupDeps = {}): Promise<void> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? ((pid: number) => defaultKill(pid));
  const state = await loadState();
  for (const entry of Object.values(state)) {
    if (isAlive(entry.pid)) {
      try { await kill(entry.pid); } catch (err) {
        console.error('[runtime/bootCleanup] kill failed', { pid: entry.pid, err });
      }
    }
  }
  await mutateState((s) => {
    for (const k of Object.keys(s)) delete s[k];
  });
}

export type LivenessDeps = {
  probe?: (port: number) => Promise<boolean>;
  kill?: (pid: number) => Promise<void>;
  now?: () => Date;
  startingTimeoutMs?: number;
  failureThreshold?: number;
};

export function makeLivenessChecker(deps: LivenessDeps = {}): () => Promise<void> {
  const probe = deps.probe ?? defaultProbe;
  const kill = deps.kill ?? ((pid: number) => defaultKill(pid));
  const now = deps.now ?? (() => new Date());
  const startingTimeoutMs = deps.startingTimeoutMs ?? 60_000;
  const failureThreshold = deps.failureThreshold ?? 3;
  const failureCounts = new Map<string, number>();

  return async function check(): Promise<void> {
    const state = await loadState();
    for (const entry of Object.values(state)) {
      if (entry.status === 'starting') {
        const ageMs = now().getTime() - new Date(entry.startedAt).getTime();
        if (ageMs > startingTimeoutMs) {
          await kill(entry.pid).catch(() => {});
          await mutateState((s) => {
            const e = s[entry.forgeId];
            if (e) e.status = 'crashed';
          });
        }
        continue;
      }
      if (entry.status !== 'running') continue;
      const ok = await probe(entry.port);
      if (ok) {
        failureCounts.delete(entry.forgeId);
        continue;
      }
      const next = (failureCounts.get(entry.forgeId) ?? 0) + 1;
      failureCounts.set(entry.forgeId, next);
      if (next >= failureThreshold) {
        failureCounts.delete(entry.forgeId);
        await kill(entry.pid).catch(() => {});
        await mutateState((s) => {
          const e = s[entry.forgeId];
          if (e) e.status = 'crashed';
        });
      }
    }
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startLivenessLoop(deps: LivenessDeps = {}, intervalMs = 5000): { stop: () => void } {
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
