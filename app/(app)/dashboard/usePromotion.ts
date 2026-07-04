'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromotionDto } from '@/lib/services/promotions';

export type Promotion = PromotionDto;

/** Statuses for which polling continues; a terminal status (accepted/rejected) stops it. */
export const ACTIVE_PROMOTION_STATUSES = ['checks_running', 'checks_failed', 'awaiting_approval'];

const POLL_INTERVAL_MS = 5000;

export function usePromotion(forgeId: string): {
  promotion: Promotion | null;
  currentVersion: string | null;
  refetch: () => Promise<void>;
} {
  const [promotion, setPromotion] = useState<Promotion | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  // True once the first fetch for the current forgeId has resolved. Until then we don't
  // yet know whether there's an active promotion, so we keep polling. This MUST be state
  // (not a ref): the common case is the first fetch resolving to `null`, which is
  // `Object.is`-equal to the initial `promotion` state, so `setPromotion(null)` alone
  // triggers no re-render in React 19 and the polling effect below would never
  // re-evaluate. Flipping this state guarantees a re-render even when `promotion`
  // itself doesn't change.
  const [hasFetched, setHasFetched] = useState(false);
  const cancelled = useRef(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/forges/${forgeId}/promotion`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        promotion: Promotion | null;
        currentVersion: string | null;
      };
      if (!cancelled.current) {
        setPromotion(body.promotion);
        setCurrentVersion(body.currentVersion ?? null);
        setHasFetched(true);
      }
    } catch {
      // Network blip — leave previous state in place.
    }
  }, [forgeId]);

  useEffect(() => {
    cancelled.current = false;
    setHasFetched(false);
    void refetch();
    return () => {
      cancelled.current = true;
    };
  }, [refetch]);

  useEffect(() => {
    // Poll while we haven't resolved the first fetch yet, or while the resolved
    // promotion is in an active status. Stop once resolved to null or a terminal status.
    const isResolvedInactive =
      hasFetched && (!promotion || !ACTIVE_PROMOTION_STATUSES.includes(promotion.status));
    if (isResolvedInactive) return;
    const handle = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [promotion, hasFetched, refetch]);

  return { promotion, currentVersion, refetch };
}
