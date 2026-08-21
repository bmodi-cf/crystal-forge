'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { BundleCandidate } from '@/lib/services/first-release';

/**
 * First-release import, on prod.
 *
 * Candidates come from the registry catalog, not the database: prod has no
 * Forge row for a forge it has never imported (spec §3.1). The section hides
 * itself when there is nothing to import, which is the steady state.
 */
export function BundleImportSection({ onImported }: { onImported: () => void }) {
  const [candidates, setCandidates] = useState<BundleCandidate[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ slug: string; version: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deployments/bundles');
      if (!res.ok) return;
      const body = (await res.json()) as { candidates: BundleCandidate[] };
      if (alive.current) setCandidates(body.candidates ?? []);
    } catch {
      // Registry blip — a stale list beats a blank section.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function runImport(slug: string, version: string) {
    setBusy((b) => ({ ...b, [slug]: true }));
    setErrors((e) => { const next = { ...e }; delete next[slug]; return next; });
    try {
      const res = await fetch(`/api/deployments/bundles/${slug}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { imported?: { version: string }; error?: string };
      if (!res.ok || !body.imported) {
        setErrors((e) => ({ ...e, [slug]: body.error ?? 'Import failed' }));
        return;
      }
      setDone((d) => ({ ...d, [slug]: body.imported!.version }));
      onImported();
      await load();
    } catch {
      setErrors((e) => ({ ...e, [slug]: 'Import failed' }));
    } finally {
      setBusy((b) => ({ ...b, [slug]: false }));
      setConfirming(null);
    }
  }

  const importedSlugs = Object.keys(done);
  if (candidates.length === 0 && importedSlugs.length === 0) return null;

  return (
    <section className="mb-8 rounded-[14px] border border-border bg-panel p-5">
      <h2 className="text-base font-semibold text-ink">Import a first release</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-dim">
        Bundles waiting in the registry. Importing writes the forge&apos;s inventory row and
        restores its pilot data, once. It cannot be undone from here.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {candidates.map((c) => {
          const version = chosen[c.slug] ?? c.versions[0] ?? '';
          return (
            <div key={c.slug} className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-ink">{c.slug}</span>
              <select
                aria-label={`Bundle version for ${c.slug}`}
                className="h-8 rounded-md border border-border bg-panel px-2 text-sm text-ink"
                value={version}
                onChange={(e) => setChosen((s) => ({ ...s, [c.slug]: e.target.value }))}
              >
                {c.versions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={busy[c.slug] || version === ''}
                onClick={() => setConfirming({ slug: c.slug, version })}
              >
                {busy[c.slug] ? 'Importing…' : 'Import'}
              </Button>
              {errors[c.slug] ? (
                <span role="alert" className="text-xs text-red-400">{errors[c.slug]}</span>
              ) : null}
            </div>
          );
        })}

        {importedSlugs.map((slug) => (
          <p key={slug} className="text-xs text-emerald-400">
            {slug} imported at {done[slug]} — it now appears in the table below, deployed.
          </p>
        ))}
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Import {confirming?.slug} {confirming?.version}?
            </DialogTitle>
            <DialogDescription>
              This restores the pilot&apos;s data into a new production database and enables the
              forge at <strong>{confirming?.version}</strong>. It runs once: a second import is
              refused, and undoing it means dropping the database by hand.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="gold"
              disabled={confirming ? !!busy[confirming.slug] : false}
              onClick={() => {
                if (confirming) void runImport(confirming.slug, confirming.version);
              }}
            >
              Import data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
