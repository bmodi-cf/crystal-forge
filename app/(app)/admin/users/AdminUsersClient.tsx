'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { Role } from '@prisma/client';

type Row = { id: string; name: string; email: string; role: Role };
const ROLES: Role[] = ['ADMIN', 'DEVELOPER', 'DEFAULT_USER'];
const LABEL: Record<Role, string> = { ADMIN: 'Admin', DEVELOPER: 'Developer', DEFAULT_USER: 'Default User' };

export function AdminUsersClient({ users, currentUserId }: { users: Row[]; currentUserId: string }) {
  const [rows, setRows] = useState(users);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function changeRole(id: string, role: Role) {
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, role } : r)));
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to update role');
      }
      toast.success('Role updated');
    } catch (err) {
      setRows(prev); // revert optimistic update
      toast.error(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Users</h1>
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-ink-dim">
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Email</th>
            <th className="py-2 font-medium">Role</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const isSelf = u.id === currentUserId;
            return (
              <tr key={u.id} className="border-b border-border/60">
                <td className="py-3">{u.name}</td>
                <td className="py-3 text-ink-dim">{u.email}</td>
                <td className="py-3">
                  <select
                    aria-label={`Role for ${u.name}`}
                    value={u.role}
                    disabled={isSelf || busyId === u.id}
                    onChange={(e) => changeRole(u.id, e.target.value as Role)}
                    className="rounded-md border border-border bg-panel px-2 py-1 text-sm text-ink disabled:opacity-50"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{LABEL[r]}</option>
                    ))}
                  </select>
                  {isSelf && <span className="ml-2 text-[11px] text-ink-faint">(you)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
