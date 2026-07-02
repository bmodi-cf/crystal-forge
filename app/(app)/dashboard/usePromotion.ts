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

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/forges/${forgeId}/promotion`);
      if (!res.ok) return;
      const body = (await res.json()) as { promotion: Promotion | null };
      if (!cancelled.current) setPromotion(body.promotion);
    } catch {
      // Network blip — leave previous state in place.
    }
  }, [forgeId]);

  useEffect(() => {
    cancelled.current = false;
    void refetch();
    return () => {
      cancelled.current = true;
    };
  }, [refetch]);

  useEffect(() => {
    // Only poll while an active request is in flight.
    if (promotion && !ACTIVE_PROMOTION_STATUSES.includes(promotion.status)) return;
    const handle = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [promotion, refetch]);

  return { promotion, refetch };
}
