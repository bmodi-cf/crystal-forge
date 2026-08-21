'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FirstReleaseCandidate } from '@/lib/services/first-release';

type CutResult = { repo: string; tag: string; bytes: number };

/**
 * First-release bundles, on the pilot.
 *
 * Its own section rather than part of the pending list: PromotionsClient
 * renders /api/promotions, which is listPendingPromotions — filtered to ACTIVE
 * statuses, so an *accepted* promotion can never appear there.
 */
export function FirstReleaseSection() {
  const [candidates, setCandidates] = useState<FirstReleaseCandidate[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, CutResult>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/promotions/first-release-candidates');
      if (!res.ok) return;
      const body = (await res.json()) as { candidates: FirstReleaseCandidate[] };
      if (alive.current) setCandidates(body.candidates ?? []);
    } catch {
      // Leave the last known list in place.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function cut(candidate: FirstReleaseCandidate) {
    const id = candidate.promotionId;
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors((e) => { const next = { ...e }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/promotions/${id}/bundle`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as
        { bundle?: CutResult; error?: string };
      if (!res.ok || !body.bundle) {
        setErrors((e) => ({ ...e, [id]: body.error ?? 'Cut failed' }));
        return;
      }
      setResults((r) => ({ ...r, [id]: body.bundle! }));
      await load();
    } catch {
      setErrors((e) => ({ ...e, [id]: 'Cut failed' }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  if (candidates.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">First-release bundles</h2>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Cuts this forge&apos;s pilot database and inventory row into{' '}
        <code>&lt;slug&gt;-seed</code> in the registry, for a one-time import on production.
        Offered only on a forge&apos;s first release.
      </p>
      {candidates.map((c) => {
        const already = c.bundleTags.includes(c.version);
        const result = results[c.promotionId];
        return (
          <article
            key={c.promotionId}
            className="flex flex-col gap-2 rounded-[14px] border border-border bg-panel p-5"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">{c.forgeName}</h3>
                <div className="text-[11px] text-ink-faint">
                  {c.version} · released {new Date(c.decidedAt).toLocaleDateString()} ·{' '}
                  {c.headSha.slice(0, 8)}
                </div>
              </div>
              <Button
                variant="outline"
                disabled={busy[c.promotionId]}
                onClick={() => void cut(c)}
              >
                {busy[c.promotionId] ? 'Cutting…' : already ? 'Re-cut bundle' : 'Cut bundle'}
              </Button>
            </div>
            {already && !result ? (
              <p className="text-[11px] text-ink-dim">
                A bundle for {c.version} was already cut. Re-cutting overwrites the tag; it does
                not affect a bundle production has already imported.
              </p>
            ) : null}
            {result ? (
              <p className="text-[11px] text-[#4ad28b]">
                Pushed {result.repo}:{result.tag} ({Math.ceil(result.bytes / 1024)} KiB of SQL).
                Import it from the production Deployments tab.
              </p>
            ) : null}
            {errors[c.promotionId] ? (
              <p role="alert" className="text-[11px] text-[#d96868]">{errors[c.promotionId]}</p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
