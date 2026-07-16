import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserMenu } from './UserMenu';
import type { SessionUser } from '@/lib/services/types';

const signOut = vi.fn();
vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}));

const user = {
  id: 'u1',
  name: 'Maya Chen',
  email: 'maya@crystalfountains.com',
  initials: 'MC',
  role: 'DEVELOPER',
} as SessionUser;

describe('UserMenu', () => {
  it('logs the user out and redirects to /login when Logout is clicked', async () => {
    render(<UserMenu user={user} />);

    // Open the dropdown, then click Logout.
    await userEvent.click(screen.getByRole('button', { name: /maya chen/i }));
    await userEvent.click(await screen.findByText('Logout'));

    // Regression guard: Base UI's Menu.Item uses onClick, not Radix's onSelect.
    // Wiring it to onSelect makes the button a silent no-op.
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('does not render a Pending Promotions link (moved to /admin)', async () => {
    const adminUser = { ...user, isAdmin: true, role: 'ADMIN' } as SessionUser;
    render(<UserMenu user={adminUser} />);

    await userEvent.click(screen.getByRole('button', { name: /maya chen/i }));

    // Wait for the menu to open by asserting a known item is present first.
    await screen.findByText('Logout');
    expect(screen.queryByText(/pending promotions/i)).not.toBeInTheDocument();
  });
});
