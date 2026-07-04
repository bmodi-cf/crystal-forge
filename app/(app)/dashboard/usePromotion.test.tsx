import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePromotion } from './usePromotion';
import type { Promotion } from './usePromotion';

function mockFetchOnce(promotion: Promotion | null): void {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ promotion }),
  });
}

function makePromotion(status: Promotion['status']): Promotion {
  return {
    id: 'p1',
    forgeId: 'f1',
    status,
    bumpLevel: 'patch',
    targetVersion: '1.0.1',
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    headSha: 'abc123',
    imageRef: null,
    summary: null,
    requestedBy: { id: 'u1', name: 'Ada Lovelace' },
    approvedBy: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    decidedAt: null,
    rejectReason: null,
  };
}

describe('usePromotion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops polling once the first fetch resolves to null (no promotion)', async () => {
    mockFetchOnce(null);
    // Any later call (there should be none) would also resolve to null.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ promotion: null }),
    });

    const { result } = renderHook(() => usePromotion('f1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.promotion).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Advance several poll intervals — no further fetches should occur.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 5);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the promotion is in an active status', async () => {
    mockFetchOnce(makePromotion('checks_running'));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ promotion: makePromotion('checks_running') }),
    });

    renderHook(() => usePromotion('f1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 2);
    });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('stops polling once the first fetch resolves to a terminal status (accepted)', async () => {
    mockFetchOnce(makePromotion('accepted'));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ promotion: makePromotion('accepted') }),
    });

    const { result } = renderHook(() => usePromotion('f1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.promotion?.status).toBe('accepted');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 5);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('usePromotion currentVersion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes the forge currentVersion returned by the API', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ promotion: null, currentVersion: 'v1.2.0' }),
    });

    const { result } = renderHook(() => usePromotion('f1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.currentVersion).toBe('v1.2.0');
  });

  it('reports null currentVersion when the forge has no accepted release', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ promotion: null, currentVersion: null }),
    });

    const { result } = renderHook(() => usePromotion('f1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.currentVersion).toBeNull();
  });
});
