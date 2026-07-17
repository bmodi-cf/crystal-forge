import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminGroupsClient } from './AdminGroupsClient';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const groups = [
  { id: 'g1', name: 'Sales', memberCount: 1, forgeCount: 2 },
  { id: 'g2', name: 'Engineering', memberCount: 0, forgeCount: 0 },
];
const allUsers = [
  { id: 'u1', name: 'Amy', email: 'amy@x.com' },
  { id: 'u2', name: 'Bob', email: 'bob@x.com' },
];
const salesDetail = {
  id: 'g1',
  name: 'Sales',
  memberCount: 1,
  forgeCount: 2,
  members: [{ id: 'u1', name: 'Amy', email: 'amy@x.com' }],
};

function ok(body: unknown) {
  return { ok: true, json: async () => body };
}
function fail(error: string) {
  return { ok: false, json: async () => ({ error }) };
}

/** Route fetch by method + path; GET detail always succeeds unless overridden. */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    if (overrides[key] !== undefined) return overrides[key];
    if (key === 'GET /api/admin/groups/g1') return ok({ group: salesDetail });
    throw new Error(`unexpected fetch: ${key}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function selectSales() {
  await userEvent.click(screen.getByRole('button', { name: 'Select group Sales' }));
  await screen.findByLabelText('Remove Amy from Sales');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AdminGroupsClient', () => {
  it('renders a selectable row per group', () => {
    stubFetch();
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    expect(screen.getByRole('button', { name: 'Select group Sales' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select group Engineering' })).toBeInTheDocument();
  });

  it('loads and shows a group detail on select', async () => {
    stubFetch();
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    await selectSales();
    expect(screen.getByLabelText('Remove Amy from Sales')).toBeInTheDocument();
    // Bob is a non-member, offered in the add-member picker.
    expect(screen.getByRole('option', { name: 'Bob (bob@x.com)' })).toBeInTheDocument();
  });

  it('adds a member optimistically and POSTs', async () => {
    const mock = stubFetch({
      'POST /api/admin/groups/g1/members': ok({ member: allUsers[1] }),
    });
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    await selectSales();

    await userEvent.selectOptions(screen.getByLabelText('Add member'), 'u2');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByLabelText('Remove Bob from Sales')).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith(
      '/api/admin/groups/g1/members',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reverts an added member when the POST fails', async () => {
    stubFetch({ 'POST /api/admin/groups/g1/members': fail('nope') });
    const { toast } = await import('sonner');
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    await selectSales();

    await userEvent.selectOptions(screen.getByLabelText('Add member'), 'u2');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    expect(screen.queryByLabelText('Remove Bob from Sales')).not.toBeInTheDocument();
  });

  it('reverts a removed member when the DELETE fails', async () => {
    stubFetch({ 'DELETE /api/admin/groups/g1/members': fail('boom') });
    const { toast } = await import('sonner');
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    await selectSales();

    await userEvent.click(screen.getByLabelText('Remove Amy from Sales'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(await screen.findByLabelText('Remove Amy from Sales')).toBeInTheDocument();
  });

  it('gates delete behind the confirm dialog', async () => {
    const mock = stubFetch({ 'DELETE /api/admin/groups/g1': ok({ impact: { memberCount: 1, forgeCount: 2 } }) });
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);
    await selectSales();

    await userEvent.click(screen.getByRole('button', { name: 'Delete group Sales' }));
    // Dialog open, but nothing deleted yet.
    expect(mock).not.toHaveBeenCalledWith('/api/admin/groups/g1', expect.objectContaining({ method: 'DELETE' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete group' }));
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith('/api/admin/groups/g1', expect.objectContaining({ method: 'DELETE' })),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Select group Sales' })).not.toBeInTheDocument(),
    );
  });

  it('creates a new group and selects it', async () => {
    stubFetch({ 'POST /api/admin/groups': ok({ group: { id: 'g3', name: 'Platform' } }) });
    render(<AdminGroupsClient groups={groups} allUsers={allUsers} />);

    await userEvent.type(screen.getByLabelText('New group name'), 'Platform');
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByRole('button', { name: 'Select group Platform' })).toBeInTheDocument();
  });
});
