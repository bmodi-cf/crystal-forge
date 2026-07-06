import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LaunchCard } from './LaunchCard';
import type { Forge } from '@/lib/services/types';

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  description: 'Hydraulic modeling toolkit.',
  tone: 'navy',
  initials: 'AD',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
  repoFullName: 'CrystalFountainsInc/aquaflow-designer',
  repoUrl: 'https://github.com/CrystalFountainsInc/aquaflow-designer',
};

describe('LaunchCard', () => {
  it('renders name and group tags, without the initials box', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
    expect(screen.queryByText('AD')).not.toBeInTheDocument();
  });

  it('is a single link opening the running app in a new window', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    const link = screen.getByRole('link', { name: /open aquaflow designer/i });
    expect(link).toHaveAttribute('href', '/app/aquaflow-designer/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
