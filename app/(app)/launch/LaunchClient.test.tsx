import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LaunchClient } from './LaunchClient';
import type { Forge } from '@/lib/services/types';
import type { RuntimeMap } from '@/app/(app)/dashboard/useForgeRuntimes';

const mockRuntimes: { current: RuntimeMap } = { current: {} };
vi.mock('@/app/(app)/dashboard/useForgeRuntimes', () => ({
  useForgeRuntimes: () => ({ runtimes: mockRuntimes.current, refetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));

function makeForge(id: string, name: string): Forge {
  return {
    id,
    name,
    description: null,
    tone: 'navy',
    initials: name.slice(0, 2).toUpperCase(),
    groups: ['Engineering'],
    createdBy: { id: 'tom', name: 'Tom Reed' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T12:00:00Z',
    repoFullName: `CrystalFountainsInc/${id}`,
    repoUrl: `https://github.com/CrystalFountainsInc/${id}`,
  };
}

const forges = [makeForge('f1', 'Aquaflow'), makeForge('f2', 'Cascade')];

beforeEach(() => {
  mockRuntimes.current = {};
});

describe('LaunchClient', () => {
  it('shows only forges whose runtime is running', () => {
    mockRuntimes.current = {
      f1: { forgeId: 'f1', slug: 'aquaflow', status: 'running', port: 4101, startedAt: '2026-07-06T00:00:00Z' },
      f2: { forgeId: 'f2', slug: 'cascade', status: 'starting', port: 4102, startedAt: '2026-07-06T00:00:00Z' },
    };
    render(<LaunchClient forges={forges} />);
    expect(screen.getByText('Aquaflow')).toBeInTheDocument();
    expect(screen.queryByText('Cascade')).not.toBeInTheDocument();
  });

  it('links each card to the runtime slug', () => {
    mockRuntimes.current = {
      f1: { forgeId: 'f1', slug: 'aquaflow', status: 'running', port: 4101, startedAt: '2026-07-06T00:00:00Z' },
    };
    render(<LaunchClient forges={forges} />);
    expect(screen.getByRole('link', { name: /open aquaflow/i })).toHaveAttribute('href', '/app/aquaflow/');
  });

  it('shows the empty state with a dashboard link when nothing is running', () => {
    render(<LaunchClient forges={forges} />);
    expect(screen.getByText(/no forges are running right now/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard');
  });
});
