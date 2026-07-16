import { describe, it, expect, vi } from 'vitest';
import { createTokenRefresher, type Scheduler } from './token-refresher';

// A scheduler that captures jobs so the test drives time by hand.
function fakeScheduler() {
  const jobs: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const scheduler: Scheduler = {
    schedule: (fn, ms) => { const j = { fn, ms, cancelled: false }; jobs.push(j); return j; },
    cancel: (h) => { (h as { cancelled: boolean }).cancelled = true; },
  };
  // fire the most recently scheduled, still-live job
  const fireLast = async () => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i]!;
      if (!j.cancelled) { j.cancelled = true; j.fn(); break; }
    }
    await Promise.resolve(); await Promise.resolve();
  };
  return { scheduler, jobs, fireLast };
}

describe('createTokenRefresher', () => {
  it('mints and writes once on first acquire, and schedules the next refresh', async () => {
    const { scheduler, jobs } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't1', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000, retryMs: 100 });

    const ok = await r.acquire('cid', 'own/repo');

    expect(ok).toBe(true);
    expect(mint).toHaveBeenCalledExactlyOnceWith('own/repo');
    expect(write).toHaveBeenCalledExactlyOnceWith('cid', 't1');
    expect(jobs.filter((j) => !j.cancelled)).toHaveLength(1);
    expect(jobs[0]!.ms).toBe(1000);
  });

  it('does not re-mint on a second acquire for the same container (ref-count)', async () => {
    const { scheduler } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler });
    await r.acquire('cid', 'own/repo');
    await r.acquire('cid', 'own/repo');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the scheduled refresh fires', async () => {
    const { scheduler, fireLast } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000 });
    await r.acquire('cid', 'own/repo');
    await fireLast();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('on mint failure: acquire returns false, calls onError, and schedules a retry', async () => {
    const { scheduler, jobs } = fakeScheduler();
    const mint = vi.fn(async () => { throw new Error('boom'); });
    const write = vi.fn(async () => {});
    const onError = vi.fn();
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000, retryMs: 100, onError });
    const ok = await r.acquire('cid', 'own/repo');
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(jobs.filter((j) => !j.cancelled)[0]!.ms).toBe(100); // retry cadence
  });

  it('release at zero ref-count cancels the pending timer and stops re-minting', async () => {
    const { scheduler, jobs, fireLast } = fakeScheduler();
    const mint = vi.fn(async () => ({ token: 't', expiresAt: 'x' }));
    const write = vi.fn(async () => {});
    const r = createTokenRefresher({ mint, write, scheduler, refreshMs: 1000 });
    await r.acquire('cid', 'own/repo');
    r.release('cid');
    expect(jobs.every((j) => j.cancelled)).toBe(true);
    await fireLast(); // nothing live to fire
    expect(mint).toHaveBeenCalledTimes(1); // no re-mint after release
  });
});
