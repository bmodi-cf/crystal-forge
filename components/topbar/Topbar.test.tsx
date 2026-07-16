import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionUser } from '@/lib/services/types';
import { Topbar } from './Topbar';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));

const user: SessionUser = {
  id: 'u',
  entraOid: null,
  email: 'maya.chen@crystalfountains.com',
  name: 'Maya Chen',
  initials: 'MC',
  groups: [],
  role: 'DEVELOPER',
  isAdmin: false,
};

const defaultUser: SessionUser = { ...user, role: 'DEFAULT_USER', isAdmin: false };
const adminUser: SessionUser = { ...user, role: 'ADMIN', isAdmin: true };

describe('Topbar', () => {
  it('renders the brand and product name', () => {
    render(<Topbar user={user} />);
    expect(screen.getByAltText(/crystal fountains/i)).toBeInTheDocument();
    expect(screen.getByText(/Forge/)).toBeInTheDocument();
  });

  it('renders the user initials in the avatar', () => {
    render(<Topbar user={user} />);
    expect(screen.getByText('MC')).toBeInTheDocument();
  });

  it('renders a Launch nav link', () => {
    render(<Topbar user={user} />);
    const link = screen.getByRole('link', { name: /launch/i });
    expect(link).toHaveAttribute('href', '/launch');
  });

  it('renders an Edit nav link back to the dashboard', () => {
    render(<Topbar user={user} />);
    const link = screen.getByRole('link', { name: /edit/i });
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('hides the Edit link for a DEFAULT_USER', () => {
    render(<Topbar user={defaultUser} />);
    expect(screen.queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /launch/i })).toBeInTheDocument();
  });

  it('shows the Admin link only for admins', () => {
    const { rerender } = render(<Topbar user={user} />);
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
    rerender(<Topbar user={adminUser} />);
    const link = screen.getByRole('link', { name: /admin/i });
    expect(link).toHaveAttribute('href', '/admin');
  });
});
