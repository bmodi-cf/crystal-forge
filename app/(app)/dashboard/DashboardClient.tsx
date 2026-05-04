'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ForgeCard } from './ForgeCard';
import { ForgeFormModal } from './ForgeFormModal';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { cn } from '@/lib/utils';
import type { Forge } from '@/lib/services/types';
import type { GroupDto } from '@/lib/services/groups';

const FILTERS = ['all', 'active', 'draft', 'archived'] as const;
type Filter = (typeof FILTERS)[number];

type Props = {
  initialForges: Forge[];
  allGroups: GroupDto[];
};

export function DashboardClient({ initialForges, allGroups }: Props) {
  const router = useRouter();
  const [forges, setForges] = useState<Forge[]>(initialForges);

  // Sync local state when the server component re-renders after router.refresh().
  useEffect(() => {
    setForges(initialForges);
  }, [initialForges]);

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Forge | null>(null);
  const [deleting, setDeleting] = useState<Forge | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const counts = useMemo(() => {
    const acc = { all: 0, active: 0, draft: 0, archived: 0 };
    for (const f of forges) {
      acc.all++;
      acc[f.status]++;
    }
    return acc;
  }, [forges]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return forges.filter((f) => {
      if (filter !== 'all' && f.status !== filter) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q) ||
        f.groups.some((g) => g.toLowerCase().includes(q))
      );
    });
  }, [forges, filter, query]);

  async function handleConfirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleteBusy(true);
    setForges((current) => current.filter((f) => f.id !== target.id));
    try {
      const res = await fetch(`/api/forges/${target.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error ?? `Delete failed (${res.status})`);
      }
      toast.success(`Deleted “${target.name}”.`);
      setDeleting(null);
      router.refresh();
    } catch (err) {
      setForges((current) => [target, ...current]);
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-8 py-10 pb-20">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Forges</h1>
          <div className="mt-1.5 text-sm text-ink-dim">
            <b className="font-medium text-ink">{counts.all}</b> applications ·{' '}
            <b className="font-medium text-ink">{counts.active}</b> active ·{' '}
            <b className="font-medium text-ink">{counts.draft}</b> in draft
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Forge
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, description, or group…"
            aria-label="Search forges"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Status filter">
          {FILTERS.map((f) => {
            const isOn = filter === f;
            return (
              <button
                key={f}
                role="tab"
                aria-selected={isOn}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] font-medium uppercase tracking-wide transition',
                  isOn
                    ? 'border-gold/40 bg-gold/[0.15] text-gold-soft'
                    : 'border-border bg-white/[0.04] text-ink-dim hover:border-border-strong',
                )}
              >
                {f === 'all' ? `All (${counts.all})` : `${f} (${counts[f]})`}
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border bg-white/[0.015] py-16 text-center text-ink-dim">
          <h4 className="mb-1.5 text-base font-medium text-ink">No forges match your filters.</h4>
          <p>Try clearing the search or switching status.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-[1.125rem]">
          {visible.map((f) => (
            <ForgeCard
              key={f.id}
              forge={f}
              onEdit={(forge) => setEditing(forge)}
              onDelete={(forge) => setDeleting(forge)}
            />
          ))}
        </div>
      )}

      <ForgeFormModal
        open={createOpen}
        mode="create"
        allGroups={allGroups}
        onCancel={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />

      {editing && (
        <ForgeFormModal
          open
          mode="edit"
          forge={editing}
          allGroups={allGroups}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <DeleteConfirmDialog
        open={!!deleting}
        forgeName={deleting?.name ?? ''}
        busy={deleteBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
      />
    </main>
  );
}
