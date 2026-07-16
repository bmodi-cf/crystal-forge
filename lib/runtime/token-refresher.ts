export type Scheduler = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

export type TokenRefresherDeps = {
  mint: (repoFullName: string) => Promise<{ token: string; expiresAt: string }>;
  write: (containerId: string, token: string) => Promise<void>;
  scheduler?: Scheduler;
  refreshMs?: number;
  retryMs?: number;
  onError?: (containerId: string, err: unknown) => void;
};

export type TokenRefresher = {
  acquire(containerId: string, repoFullName: string): Promise<boolean>;
  release(containerId: string): void;
};

const DEFAULT_REFRESH_MS = 45 * 60 * 1000; // under GitHub's ~60m token life
const DEFAULT_RETRY_MS = 5 * 60 * 1000;

const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Entry = {
  refs: number;
  repoFullName: string;
  handle: unknown;
  hasToken: boolean;
  stopped: boolean;
};

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const scheduler = deps.scheduler ?? defaultScheduler;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const entries = new Map<string, Entry>();

  async function tick(containerId: string): Promise<void> {
    const e = entries.get(containerId);
    if (!e || e.stopped) return; // released mid-flight
    try {
      const { token } = await deps.mint(e.repoFullName);
      await deps.write(containerId, token);
      e.hasToken = true;
      e.handle = scheduler.schedule(() => { void tick(containerId); }, refreshMs);
    } catch (err) {
      deps.onError?.(containerId, err);
      e.handle = scheduler.schedule(() => { void tick(containerId); }, retryMs);
    }
  }

  return {
    async acquire(containerId, repoFullName) {
      const existing = entries.get(containerId);
      if (existing) { existing.refs += 1; return existing.hasToken; }
      const e: Entry = { refs: 1, repoFullName, handle: null, hasToken: false, stopped: false };
      entries.set(containerId, e);
      await tick(containerId); // mint before the first git op; never throws
      return e.hasToken;
    },
    release(containerId) {
      const e = entries.get(containerId);
      if (!e) return;
      e.refs -= 1;
      if (e.refs > 0) return;
      e.stopped = true;
      if (e.handle != null) scheduler.cancel(e.handle);
      entries.delete(containerId);
    },
  };
}
