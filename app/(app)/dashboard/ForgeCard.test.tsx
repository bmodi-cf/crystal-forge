import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCard } from './ForgeCard';
import type { Forge } from '@/lib/services/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}));

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  displayName: null,
  description: 'Hydraulic modeling toolkit.',
  tone: 'navy',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
  repoFullName: 'bmodi-cf/aquaflow-designer',
  repoUrl: 'https://github.com/bmodi-cf/aquaflow-designer',
};

describe('ForgeCard', () => {
  it('renders name, description, and groups', () => {
    render(<ForgeCard forge={forge} canWrite runtime={null} onRuntimeAction={() => {}} />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('Hydraulic modeling toolkit.')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
  });

  it('prefers displayName over name when set', () => {
    render(
      <ForgeCard
        forge={{ ...forge, displayName: 'Aquaflow' }}
        canWrite
        runtime={null}
        onRuntimeAction={() => {}}
      />,
    );
    expect(screen.getByText('Aquaflow')).toBeInTheDocument();
    expect(screen.queryByText('Aquaflow Designer')).not.toBeInTheDocument();
  });

  it('renders a "View on GitHub" link pointing at repoUrl', () => {
    render(<ForgeCard forge={forge} canWrite runtime={null} onRuntimeAction={() => {}} />);
    const link = screen.getByRole('link', { name: /view on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/bmodi-cf/aquaflow-designer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('does not render edit / delete buttons when callbacks are absent', () => {
    render(<ForgeCard forge={forge} canWrite runtime={null} onRuntimeAction={() => {}} />);
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onEdit when the edit button is clicked', async () => {
    const onEdit = vi.fn();
    render(<ForgeCard forge={forge} canWrite runtime={null} onRuntimeAction={() => {}} onEdit={onEdit} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(forge);
  });

  it('calls onDelete when the delete button is clicked', async () => {
    const onDelete = vi.fn();
    render(<ForgeCard forge={forge} canWrite runtime={null} onRuntimeAction={() => {}} onEdit={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(forge);
  });
});
