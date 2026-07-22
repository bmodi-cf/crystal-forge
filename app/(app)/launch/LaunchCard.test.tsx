import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LaunchCard } from './LaunchCard';
import type { Forge } from '@/lib/services/types';

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  displayName: null,
  description: 'Hydraulic modeling toolkit.',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
  repoFullName: 'CrystalFountainsInc/aquaflow-designer',
  repoUrl: 'https://github.com/CrystalFountainsInc/aquaflow-designer',
};

describe('LaunchCard', () => {
  it('renders name and the full description, not group tags', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('Hydraulic modeling toolkit.')).toBeInTheDocument();
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
    expect(screen.queryByText('R&D')).not.toBeInTheDocument();
  });

  it('is a single link opening the running app in a new window', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    const link = screen.getByRole('link', { name: /open aquaflow designer/i });
    expect(link).toHaveAttribute('href', '/app/aquaflow-designer/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it("shows the forge's own splash-logo.png as a hero image", () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    const img = screen.getByRole('presentation', { hidden: true });
    expect(img).toHaveAttribute('src', '/app/aquaflow-designer/splash-logo.png');
  });

  it('hides the hero image if the forge has none (image fails to load)', () => {
    render(<LaunchCard forge={forge} slug="aquaflow-designer" />);
    const img = screen.getByRole('presentation', { hidden: true });
    fireEvent.error(img);
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });
});
