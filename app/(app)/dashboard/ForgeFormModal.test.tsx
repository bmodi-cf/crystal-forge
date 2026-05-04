import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeFormModal } from './ForgeFormModal';
import type { Forge } from '@/lib/services/types';

const ALL_GROUPS = [
  { id: 'g1', name: 'Engineering' },
  { id: 'g2', name: 'Operations' },
  { id: 'g3', name: 'Sales' },
];

const FORGE: Forge = {
  id: 'forge-1',
  name: 'Aquaflow',
  description: 'Hydraulics',
  status: 'draft',
  tone: 'navy',
  initials: 'AQ',
  groups: ['Engineering'],
  createdBy: { id: 'u1', name: 'Tom' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('ForgeFormModal', () => {
  it('shows "New Forge" title and empty fields in create mode', () => {
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /new forge/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('');
  });

  it('shows "Edit Forge" title and pre-fills fields in edit mode', () => {
    render(
      <ForgeFormModal
        open
        mode="edit"
        forge={FORGE}
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /edit forge/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('Aquaflow');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Hydraulics');
  });

  it('blocks submit and surfaces a name error when name is empty', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('blocks submit and surfaces a groups error when nothing is picked', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/name/i), 'Test');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/pick at least one group/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('POSTs and calls onSaved when create succeeds', async () => {
    const onSaved = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ forge: { ...FORGE, id: 'new', name: 'Aquaflow', groups: ['Engineering'] } }),
    } as Response);

    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/name/i), 'Aquaflow');
    await userEvent.click(screen.getByRole('button', { name: /^engineering$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/forges',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onSaved).toHaveBeenCalled();
  });
});
