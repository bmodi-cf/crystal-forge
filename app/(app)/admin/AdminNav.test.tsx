// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminNav } from './AdminNav';

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    <a href={href} className={className}>{children}</a>,
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/users' }));

describe('AdminNav', () => {
  it('always links Users and Groups', () => {
    render(<AdminNav prodMode={false} />);
    expect(screen.getByRole('link', { name: /users/i })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: /groups/i })).toHaveAttribute('href', '/admin/groups');
  });

  it('shows Promotions, not Deployments, in dev mode', () => {
    render(<AdminNav prodMode={false} />);
    expect(screen.getByRole('link', { name: /promotions/i })).toHaveAttribute('href', '/admin/promotions');
    expect(screen.queryByRole('link', { name: /deployments/i })).not.toBeInTheDocument();
  });

  it('shows Deployments, not Promotions, in prod mode', () => {
    render(<AdminNav prodMode />);
    expect(screen.getByRole('link', { name: /deployments/i })).toHaveAttribute('href', '/admin/deployments');
    expect(screen.queryByRole('link', { name: /promotions/i })).not.toBeInTheDocument();
  });

  // Inactive items carry `hover:bg-panel`, so match the active pair exactly.
  it('marks the active item', () => {
    render(<AdminNav prodMode />);
    expect(screen.getByRole('link', { name: /users/i }).className).toContain('bg-panel text-ink');
    expect(screen.getByRole('link', { name: /deployments/i }).className).toContain('text-ink-dim');
  });
});
