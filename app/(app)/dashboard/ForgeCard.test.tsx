import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCard } from './ForgeCard';
import type { Forge } from '@/lib/services/types';

const forge: Forge = {
  id: 'forge-1',
  name: 'Aquaflow Designer',
  description: 'Hydraulic modeling toolkit.',
  status: 'active',
  tone: 'navy',
  initials: 'AD',
  groups: ['Engineering', 'R&D'],
  createdBy: { id: 'tom', name: 'Tom Reed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T12:00:00Z',
};

describe('ForgeCard', () => {
  it('renders name, description, initials, and groups', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.getByText('Aquaflow Designer')).toBeInTheDocument();
    expect(screen.getByText('Hydraulic modeling toolkit.')).toBeInTheDocument();
    expect(screen.getByText('AD')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
  });

  it('shows the status label in uppercase form', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.getByText(/ACTIVE/i)).toBeInTheDocument();
  });

  it('does not render edit / delete buttons when callbacks are absent', () => {
    render(<ForgeCard forge={forge} />);
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onEdit when the edit button is clicked', async () => {
    const onEdit = vi.fn();
    render(<ForgeCard forge={forge} onEdit={onEdit} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(forge);
  });

  it('calls onDelete when the delete button is clicked', async () => {
    const onDelete = vi.fn();
    render(<ForgeCard forge={forge} onEdit={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(forge);
  });
});
