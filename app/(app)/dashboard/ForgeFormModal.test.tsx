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
  tone: 'navy',
  initials: 'AQ',
  groups: ['Engineering'],
  createdBy: { id: 'u1', name: 'Tom' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  repoFullName: 'bmodi-cf/aquaflow',
  repoUrl: 'https://github.com/bmodi-cf/aquaflow',
};

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('ForgeFormModal', () => {
  it('shows "New Forge" title and an editable Name input in create mode', () => {
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /new forge/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('');
    expect(screen.getByLabelText(/name/i)).not.toHaveAttribute('readonly');
  });

  it('shows "Edit Forge" title and renders Name as a non-editable display row', () => {
    render(
      <ForgeFormModal
        open
        mode="edit"
        forge={FORGE}
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: /edit forge/i })).toBeInTheDocument();
    // Name is visible as text, not as an input
    expect(screen.getByText('Aquaflow')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toHaveValue('Hydraulics');
  });

  it('blocks submit and surfaces a name error when name is empty', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('blocks submit when name has illegal characters', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.type(screen.getByLabelText(/name/i), 'Bad!Name');
    await userEvent.click(screen.getByRole('button', { name: /^engineering$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(
      await screen.findByText(/letters, numbers, spaces, underscores and dashes/i),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('blocks submit and surfaces a groups error when nothing is picked', async () => {
    const onSaved = vi.fn();
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
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
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
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

  it('disables groups the non-admin user is not a member of (create mode)', () => {
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={['Engineering']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^engineering$/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^operations$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^sales$/i })).toBeDisabled();
  });

  it('keeps a foreign already-selected group deselectable in edit mode (non-admin)', () => {
    render(
      <ForgeFormModal
        open
        mode="edit"
        forge={{ ...FORGE, groups: ['Sales'] }}
        allGroups={ALL_GROUPS}
        myGroups={['Engineering']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    // Sales is selected → clickable so it can be removed.
    const sales = screen.getByRole('button', { name: /^sales$/i });
    expect(sales).not.toBeDisabled();
    expect(sales).toHaveAttribute('aria-pressed', 'true');
    // Operations is not selected and not in user's groups → disabled.
    expect(screen.getByRole('button', { name: /^operations$/i })).toBeDisabled();
  });

  it('admin sees every group as clickable, regardless of membership', () => {
    render(
      <ForgeFormModal
        open
        mode="create"
        allGroups={ALL_GROUPS}
        myGroups={[]}
        isAdmin
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^engineering$/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^operations$/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^sales$/i })).not.toBeDisabled();
  });

  it('PATCHes WITHOUT a name field in edit mode', async () => {
    const onSaved = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ forge: FORGE }),
    } as Response);

    render(
      <ForgeFormModal
        open
        mode="edit"
        forge={FORGE}
        allGroups={ALL_GROUPS}
        myGroups={['Engineering', 'Operations', 'Sales']}
        isAdmin={false}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await userEvent.clear(screen.getByLabelText(/description/i));
    await userEvent.type(screen.getByLabelText(/description/i), 'Updated copy');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(global.fetch).toHaveBeenCalled();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, init] = calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('name');
    expect(body.description).toBe('Updated copy');
    expect(onSaved).toHaveBeenCalled();
  });
});
