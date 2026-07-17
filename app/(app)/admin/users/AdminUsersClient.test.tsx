import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminUsersClient } from './AdminUsersClient';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const users = [
  { id: 'u1', name: 'Amy Dev', email: 'amy@x.com', role: 'DEVELOPER' as const },
  { id: 'me', name: 'Me Admin', email: 'me@x.com', role: 'ADMIN' as const },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AdminUsersClient', () => {
  it('renders a row per user', () => {
    render(<AdminUsersClient users={users} currentUserId="me" />);
    expect(screen.getByText('Amy Dev')).toBeInTheDocument();
    expect(screen.getByText('me@x.com')).toBeInTheDocument();
  });

  it("disables the current user's own role select", () => {
    render(<AdminUsersClient users={users} currentUserId="me" />);
    expect(screen.getByLabelText('Role for Me Admin')).toBeDisabled();
    expect(screen.getByLabelText('Role for Amy Dev')).not.toBeDisabled();
  });

  it('PATCHes and toasts on role change', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const { toast } = await import('sonner');

    render(<AdminUsersClient users={users} currentUserId="me" />);
    fireEvent.change(screen.getByLabelText('Role for Amy Dev'), { target: { value: 'ADMIN' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users/u1/role',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('reverts and toasts error on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    vi.stubGlobal('fetch', fetchMock);
    const { toast } = await import('sonner');

    render(<AdminUsersClient users={users} currentUserId="me" />);
    const select = screen.getByLabelText('Role for Amy Dev') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ADMIN' } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    await waitFor(() => expect(select.value).toBe('DEVELOPER')); // reverted
  });
});
