'use client';

import { useEffect, useRef, useState } from 'react';
import type { RuntimeStateView } from '@/lib/runtime/types';

export type RuntimeMap = Record<string, RuntimeStateView>;

const POLL_INTERVAL_MS = 3000;

export function useForgeRuntimes(): {
  runtimes: RuntimeMap;
  refetch: () => Promise<void>;
} {
  const [runtimes, setRuntimes] = useState<RuntimeMap>({});
  const cancelled = useRef(false);

  async function fetchOnce(): Promise<void> {
    try {
      const res = await fetch('/api/forges/runtime');
      if (!res.ok) return;
      const body = (await res.json()) as { runtimes: RuntimeMap };
      if (!cancelled.current) setRuntimes(body.runtimes ?? {});
    } catch {
      // Network blip — leave previous state in place.
    }
  }

  useEffect(() => {
    cancelled.current = false;
    void fetchOnce();
    const handle = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(handle);
    };
  }, []);

  return { runtimes, refetch: fetchOnce };
}
