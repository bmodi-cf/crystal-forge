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
});
