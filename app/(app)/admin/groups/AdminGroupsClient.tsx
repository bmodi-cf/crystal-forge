'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type GroupSummary = { id: string; name: string; memberCount: number; forgeCount: number };
type Member = { id: string; name: string; email: string };
type GroupDetail = GroupSummary & { members: Member[] };
type UserOption = { id: string; name: string; email: string };

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function AdminGroupsClient({
  groups: initialGroups,
  allUsers,
}: {
  groups: GroupSummary[];
  allUsers: UserOption[];
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function selectGroup(id: string) {
    setSelectedId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/admin/groups/${id}`);
      if (!res.ok) throw new Error(await readError(res, 'Failed to load group'));
      const body = (await res.json()) as { group: GroupDetail };
      setDetail(body.group);
      setNameDraft(body.group.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load group');
      setSelectedId(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function createGroup() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/admin/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to create group'));
      const body = (await res.json()) as { group: { id: string; name: string } };
      const summary: GroupSummary = { ...body.group, memberCount: 0, forgeCount: 0 };
      setGroups((gs) => [...gs, summary].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName('');
      setSelectedId(summary.id);
      setDetail({ ...summary, members: [] });
      setNameDraft(summary.name);
      toast.success('Group created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setCreating(false);
    }
  }

  async function renameGroup() {
    if (!detail) return;
    const name = nameDraft.trim();
    if (!name || name === detail.name || savingName) return;
    const prevGroups = groups;
    const prevDetail = detail;
    setGroups((gs) =>
      gs
        .map((g) => (g.id === detail.id ? { ...g, name } : g))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    setDetail({ ...detail, name });
    setSavingName(true);
    try {
      const res = await fetch(`/api/admin/groups/${detail.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to rename group'));
      toast.success('Group renamed');
    } catch (err) {
      setGroups(prevGroups);
      setDetail(prevDetail);
      setNameDraft(prevDetail.name);
      toast.error(err instanceof Error ? err.message : 'Failed to rename group');
    } finally {
      setSavingName(false);
    }
  }

  async function addMember() {
    if (!detail || !addUserId) return;
    const user = allUsers.find((u) => u.id === addUserId);
    if (!user) return;
    const prevGroups = groups;
    const prevDetail = detail;
    const nextMembers = [...detail.members, user].sort((a, b) => a.name.localeCompare(b.name));
    setDetail({ ...detail, members: nextMembers, memberCount: nextMembers.length });
    setGroups((gs) =>
      gs.map((g) => (g.id === detail.id ? { ...g, memberCount: nextMembers.length } : g)),
    );
    setAddUserId('');
    try {
      const res = await fetch(`/api/admin/groups/${detail.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to add member'));
      toast.success(`Added ${user.name}`);
    } catch (err) {
      setGroups(prevGroups);
      setDetail(prevDetail);
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    }
  }

  async function removeMember(user: Member) {
    if (!detail) return;
    const prevGroups = groups;
    const prevDetail = detail;
    const nextMembers = detail.members.filter((m) => m.id !== user.id);
    setDetail({ ...detail, members: nextMembers, memberCount: nextMembers.length });
    setGroups((gs) =>
      gs.map((g) => (g.id === detail.id ? { ...g, memberCount: nextMembers.length } : g)),
    );
    try {
      const res = await fetch(`/api/admin/groups/${detail.id}/members`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to remove member'));
      toast.success(`Removed ${user.name}`);
    } catch (err) {
      setGroups(prevGroups);
      setDetail(prevDetail);
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    }
  }

  async function deleteGroup() {
    if (!detail || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/groups/${detail.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res, 'Failed to delete group'));
      setGroups((gs) => gs.filter((g) => g.id !== detail.id));
      setSelectedId(null);
      setDetail(null);
      setConfirmDelete(false);
      toast.success(`Deleted ${detail.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete group');
    } finally {
      setDeleting(false);
    }
  }

  const nonMembers = detail
    ? allUsers.filter((u) => !detail.members.some((m) => m.id === u.id))
    : [];

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Groups</h1>
      <div className="mt-6 flex gap-8">
        {/* Left — groups list + create */}
        <div className="w-72 shrink-0">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void createGroup();
            }}
          >
            <Input
              aria-label="New group name"
              placeholder="New group name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" disabled={!newName.trim() || creating} aria-label="Create group">
              <Plus /> New
            </Button>
          </form>
          <ul className="mt-4 flex flex-col gap-1">
            {groups.length === 0 && (
              <li className="px-3 py-2 text-[13px] text-ink-faint">No groups yet.</li>
            )}
            {groups.map((g) => {
              const active = g.id === selectedId;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    aria-label={`Select group ${g.name}`}
                    aria-current={active}
                    onClick={() => void selectGroup(g.id)}
                    className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition ${
                      active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
                    }`}
                  >
                    <span className="truncate">{g.name}</span>
                    <span className="ml-2 shrink-0 text-[11px] text-ink-faint">
                      {g.memberCount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right — selected-group detail */}
        <div className="min-w-0 flex-1">
          {!selectedId ? (
            <p className="text-[13px] text-ink-dim">Select a group to manage its members.</p>
          ) : loadingDetail || !detail ? (
            <p className="text-[13px] text-ink-dim">Loading…</p>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex items-end justify-between gap-4">
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void renameGroup();
                  }}
                >
                  <Input
                    aria-label="Group name"
                    className="w-64"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      !nameDraft.trim() || nameDraft.trim() === detail.name || savingName
                    }
                  >
                    Rename
                  </Button>
                </form>
                <Button
                  variant="destructive"
                  aria-label={`Delete group ${detail.name}`}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash /> Delete group
                </Button>
              </div>

              <div className="text-[12px] text-ink-faint">
                {detail.memberCount} {detail.memberCount === 1 ? 'member' : 'members'} ·{' '}
                {detail.forgeCount} {detail.forgeCount === 1 ? 'forge' : 'forges'}
              </div>

              {/* Add member */}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addMember();
                }}
              >
                <select
                  aria-label="Add member"
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm text-ink disabled:opacity-50"
                  disabled={nonMembers.length === 0}
                >
                  <option value="">
                    {nonMembers.length === 0 ? 'Everyone is a member' : 'Add a member…'}
                  </option>
                  {nonMembers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
                <Button type="submit" variant="outline" disabled={!addUserId}>
                  <Plus /> Add
                </Button>
              </form>

              {/* Member list */}
              <ul className="flex flex-col divide-y divide-border/60">
                {detail.members.length === 0 && (
                  <li className="py-3 text-[13px] text-ink-faint">No members yet.</li>
                )}
                {detail.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink">{m.name}</div>
                      <div className="truncate text-[12px] text-ink-dim">{m.email}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${m.name} from ${detail.name}`}
                      onClick={() => void removeMember(m)}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {detail?.name}?</DialogTitle>
            <DialogDescription>
              {detail && (
                <>
                  <strong>{detail.name}</strong> has <strong>{detail.memberCount} members</strong>{' '}
                  and <strong>{detail.forgeCount} forges</strong>. Deleting it removes the group
                  from all of them — members may lose access to those forges. This can&apos;t be
                  undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void deleteGroup()}>
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
