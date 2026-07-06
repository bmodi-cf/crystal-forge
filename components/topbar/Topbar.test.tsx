import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Topbar } from './Topbar';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));

const user = {
  id: 'u',
  entraOid: null,
  email: 'maya.chen@crystalfountains.com',
  name: 'Maya Chen',
  initials: 'MC',
  groups: [],
  isAdmin: false,
};

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
});
