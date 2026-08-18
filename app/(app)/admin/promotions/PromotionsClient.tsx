'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  promotionBlocker,
  promotionStatusLabel,
  canAcceptPromotion,
} from '@/lib/services/promotion-blocker';

const POLL_INTERVAL_MS = 5000;

type Gate = { name: string; status: string; conclusion: string | null };
type Promotion = {
  id: string;
  forgeId: string;
  status: string;
  targetVersion: string;
  prUrl: string;
  createdAt: string;
  requestedBy: { name: string };
  summary: {
    forgeName: string;
    commits: number;
    changedFiles: number;
    gates: Gate[];
    mergeable?: boolean | null;
  } | null;
};

export function PromotionsClient() {
  const [items, setItems] = useState<Promotion[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/promotions');
      if (!res.ok) return;
      const body = (await res.json()) as { promotions: Promotion[] };
      if (!cancelled.current) setItems(body.promotions);
    } catch {
      // Network blip — leave previous state in place.
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void load();
    const handle = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(handle);
    };
  }, [load]);

  async function act(id: string, action: 'accept' | 'reject') {
    setBusyId(id);
    try {
      const res = await fetch(`/api/promotions/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast.error(b?.error ?? `${action} failed`);
        return;
      }
      toast.success(action === 'accept' ? 'Released' : 'Rejected');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">Pending Promotions</h1>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-dim">No pending requests.</p>
      ) : (
        items.map((p) => {
          const blocker = promotionBlocker(p);
          const ready = canAcceptPromotion(p);
          const gates = p.summary?.gates ?? [];
          return (
            <article
              key={p.id}
              className="flex flex-col gap-3 rounded-[14px] border border-border bg-panel p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold">{p.summary?.forgeName ?? p.forgeId}</h3>
                  <div className="text-[11px] text-ink-faint">
                    {p.targetVersion} · requested by {p.requestedBy.name} ·{' '}
                    <a href={p.prUrl} target="_blank" rel="noreferrer" className="underline">
                      PR
                    </a>
                  </div>
                </div>
                <span className={`text-[12px] ${blocker ? 'text-[#d96868]' : 'text-ink-dim'}`}>
                  {promotionStatusLabel(p)}
                </span>
              </div>
              {blocker ? (
                <div
                  role="alert"
                  className="rounded-[10px] border border-[#d96868]/40 bg-[#d96868]/5 px-3 py-2"
                >
                  <div className="text-[12px] font-semibold text-[#d96868]">{blocker.title}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{blocker.message}</p>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {gates.length === 0 ? (
                  <span className="text-[11px] text-ink-faint">
                    No gate runs reported for this commit yet.
                  </span>
                ) : null}
                {gates.map((g) => (
                  <span
                    key={g.name}
                    className={`rounded-md border px-2 py-1 text-[11px] ${
                      g.conclusion === 'success' || g.conclusion === 'skipped'
                        ? 'border-[#4ad28b]/40 text-[#4ad28b]'
                        : g.status !== 'completed'
                          ? 'border-border text-ink-dim'
                          : 'border-[#d96868]/40 text-[#d96868]'
                    }`}
                  >
                    {g.name}: {g.conclusion ?? g.status}
                  </span>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={busyId === p.id} onClick={() => act(p.id, 'reject')}>
                  Reject
                </Button>
                <Button
                  variant="gold"
                  disabled={busyId === p.id || !ready}
                  title={ready ? undefined : (blocker?.message ?? 'All gates must pass first')}
                  onClick={() => act(p.id, 'accept')}
                >
                  Accept &amp; release
                </Button>
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}
