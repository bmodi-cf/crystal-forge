'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromotionDto } from '@/lib/services/promotions';

export type Promotion = PromotionDto;

/** Statuses for which polling continues; a terminal status (accepted/rejected) stops it. */
export const ACTIVE_PROMOTION_STATUSES = ['checks_running', 'checks_failed', 'awaiting_approval'];

const POLL_INTERVAL_MS = 5000;

export function usePromotion(forgeId: string): {
  promotion: Promotion | null;
  refetch: () => Promise<void>;
} {
  const [promotion, setPromotion] = useState<Promotion | null>(null);
  const cancelled = useRef(false);
  // True once the first fetch for the current forgeId has resolved. Until then we don't
  // yet know whether there's an active promotion, so we keep polling.
  const hasFetched = useRef(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/forges/${forgeId}/promotion`);
      if (!res.ok) return;
      const body = (await res.json()) as { promotion: Promotion | null };
      if (!cancelled.current) {
        hasFetched.current = true;
        setPromotion(body.promotion);
      }
    } catch {
      // Network blip — leave previous state in place.
    }
  }, [forgeId]);

  useEffect(() => {
    cancelled.current = false;
    hasFetched.current = false;
    void refetch();
    return () => {
      cancelled.current = true;
    };
  }, [refetch]);

  useEffect(() => {
    // Poll while we haven't resolved the first fetch yet, or while the resolved
    // promotion is in an active status. Stop once resolved to null or a terminal status.
    const isResolvedInactive =
      hasFetched.current && (!promotion || !ACTIVE_PROMOTION_STATUSES.includes(promotion.status));
    if (isResolvedInactive) return;
    const handle = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [promotion, refetch]);

  return { promotion, refetch };
}
