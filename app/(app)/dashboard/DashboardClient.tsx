'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ForgeCard } from './ForgeCard';
import { useForgeRuntimes } from './useForgeRuntimes';
import type { RuntimeAction } from './ForgeCardRuntime';
import { ForgeFormModal } from './ForgeFormModal';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import type { Forge } from '@/lib/services/types';
import type { GroupDto } from '@/lib/services/groups';

type Props = {
  initialForges: Forge[];
  allGroups: GroupDto[];
  myGroups: string[];
  isAdmin: boolean;
  currentUserId: string;
};

export function DashboardClient({ initialForges, allGroups, myGroups, isAdmin, currentUserId }: Props) {
  const router = useRouter();
  const [forges, setForges] = useState<Forge[]>(initialForges);
  const [seenInitial, setSeenInitial] = useState(initialForges);
  // When router.refresh() delivers new initialForges from the RSC, sync local
  // state during render — the React 19 idiom that avoids set-state-in-effect.
  if (seenInitial !== initialForges) {
    setSeenInitial(initialForges);
    setForges(initialForges);
  }

  const { runtimes, refetch: refetchRuntimes } = useForgeRuntimes();

  async function handleRuntimeAction(forge: Forge, action: RuntimeAction): Promise<void> {
    try {
      const res = await fetch(`/api/forges/${forge.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `${action} failed (${res.status})`);
      }
      void refetchRuntimes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    }
  }

  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Forge | null>(null);
  const [deleting, setDeleting] = useState<Forge | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return forges.filter((f) => {
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q) ||
        f.groups.some((g) => g.toLowerCase().includes(q))
      );
    });
  }, [forges, query]);

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
      toast.success(`Deleted “${target.displayName || target.name}”.`);
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
            <b className="font-medium text-ink">{forges.length}</b> applications
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
      </div>

      {visible.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border bg-white/[0.015] py-16 text-center text-ink-dim">
          <h4 className="mb-1.5 text-base font-medium text-ink">No forges match your search.</h4>
          <p>Try clearing the search.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-[1.125rem]">
          {visible.map((f) => (
            <ForgeCard
              key={f.id}
              forge={f}
              canWrite={isAdmin || f.createdBy.id === currentUserId}
              runtime={runtimes[f.id] ?? null}
              onRuntimeAction={handleRuntimeAction}
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
        myGroups={myGroups}
        isAdmin={isAdmin}
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
          myGroups={myGroups}
          isAdmin={isAdmin}
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
