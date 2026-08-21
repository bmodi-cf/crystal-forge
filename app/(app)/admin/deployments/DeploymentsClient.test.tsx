// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DeploymentsClient } from './DeploymentsClient';
import type { DeploymentRow } from '@/lib/services/deployments';

const RUNNING: DeploymentRow = {
  forgeId: 'f1', name: 'Crystal Lattice', displayName: null, slug: 'crystal-lattice',
  deployEnabled: true, pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2',
  phase: 'running', error: null, consecutiveFailures: 0,
};
const FAILED: DeploymentRow = {
  forgeId: 'f2', name: 'Acme', displayName: null, slug: 'acme',
  deployEnabled: true, pinnedVersion: 'v9.9.9', runningVersion: null,
  phase: 'failed', error: 'pull failed', consecutiveFailures: 3,
};
const NO_IMAGE: DeploymentRow = {
  forgeId: 'f3', name: 'Second Set of Eyes', displayName: null, slug: 'second-set-of-eyes',
  deployEnabled: false, pinnedVersion: null, runningVersion: null,
  phase: null, error: null, consecutiveFailures: 0,
};
const PINNED_NOT_NEWEST: DeploymentRow = {
  forgeId: 'f4', name: 'Pinned Older', displayName: null, slug: 'pinned-older',
  deployEnabled: true, pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2',
  phase: 'running', error: null, consecutiveFailures: 0,
};

const STOPPED: DeploymentRow = {
  forgeId: 'f5', name: 'Halted', displayName: null, slug: 'halted',
  deployEnabled: false, pinnedVersion: 'v1.0.2', runningVersion: null,
  phase: null, error: null, consecutiveFailures: 0,
};
const STOPPING: DeploymentRow = {
  forgeId: 'f6', name: 'Winding Down', displayName: null, slug: 'winding-down',
  deployEnabled: false, pinnedVersion: 'v1.0.2', runningVersion: 'v1.0.2',
  phase: 'running', error: null, consecutiveFailures: 0,
};

/** Every write the client makes: deploy, start and stop. Start/stop carry no body. */
const actionCalls: Array<{ url: string; body: unknown }> = [];

type DeployResult = { ok: false; error: string } | 'throw';

function mockFetch(
  rows: DeploymentRow[],
  versions: Record<string, string[] | null>,
  deployResult?: DeployResult,
  versionsOk = true,
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/deployments')) {
      return { ok: true, json: async () => ({ deployments: rows }) };
    }
    if (url.endsWith('/api/deployments/versions')) {
      if (!versionsOk) {
        return { ok: false, json: async () => ({ error: 'registry unreachable' }) };
      }
      return { ok: true, json: async () => ({ versions }) };
    }
    if (url.endsWith('/api/deployments/bundles')) {
      return { ok: true, json: async () => ({ candidates: [] }) };
    }
    actionCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (deployResult === 'throw') {
      throw new Error('network down');
    }
    if (deployResult && deployResult.ok === false) {
      return { ok: false, json: async () => ({ error: deployResult.error }) };
    }
    return { ok: true, json: async () => ({ deployment: rows[0] }) };
  });
}

beforeEach(() => { actionCalls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('DeploymentsClient', () => {
  it('renders every forge including never-deployed ones', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING, FAILED, NO_IMAGE], {
      f1: ['v1.1.0', 'v1.0.2'], f2: ['v1.0.0'], f3: [],
    }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('Crystal Lattice')).toBeInTheDocument());
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Second Set of Eyes')).toBeInTheDocument();
  });

  it('shows the failure reason and count', async () => {
    vi.stubGlobal('fetch', mockFetch([FAILED], { f2: ['v1.0.0'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    expect(screen.getByText(/pull failed/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed attempts/)).toBeInTheDocument();
  });

  it('disables deploy and shows no image when a forge has no versions', async () => {
    vi.stubGlobal('fetch', mockFetch([NO_IMAGE], { f3: [] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('no image')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
  });

  it('does not show no image when the registry lookup failed', async () => {
    vi.stubGlobal('fetch', mockFetch([NO_IMAGE], { f3: null }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('not deployed')).toBeInTheDocument());
    expect(screen.queryByText('no image')).not.toBeInTheDocument();
  });

  it('posts the selected version when deploy is pressed', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], { f1: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1.1.0' } });
    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0]!.url).toContain('/api/deployments/f1/deploy');
    expect(actionCalls[0]!.body).toEqual({ version: 'v1.1.0' });
  });

  it('shows the rejection reason and resets the button when the deploy route refuses', async () => {
    vi.stubGlobal('fetch', mockFetch(
      [RUNNING],
      { f1: ['v1.1.0', 'v1.0.2'] },
      { ok: false, error: 'Version v1.1.0 is not available for crystal-lattice' },
    ));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1.1.0' } });
    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() =>
      expect(screen.getByText(/not available for crystal-lattice/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeInTheDocument();
  });

  it('shows a failure message and does not throw when the deploy request itself fails', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], { f1: ['v1.1.0', 'v1.0.2'] }, 'throw'));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1.1.0' } });
    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(screen.getByText('Deploy failed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeInTheDocument();
  });

  it('shows the reconciler failure reason even when the registry is also unreachable', async () => {
    vi.stubGlobal('fetch', mockFetch([FAILED], { f2: null }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    expect(screen.getByText(/pull failed/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed attempts/)).toBeInTheDocument();
    expect(screen.getByText(/registry unavailable/)).toBeInTheDocument();
  });

  it('shows a page-level message when the versions fetch fails', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], {}, undefined, false));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('Crystal Lattice')).toBeInTheDocument());
    expect(screen.getByText(/could not load available versions/i)).toBeInTheDocument();
  });

  it('defaults the version dropdown to the pinned version, not the newest tag', async () => {
    vi.stubGlobal('fetch', mockFetch([PINNED_NOT_NEWEST], { f4: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    expect(screen.getByRole('combobox')).toHaveValue('v1.0.2');

    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0]!.url).toContain('/api/deployments/f4/deploy');
    expect(actionCalls[0]!.body).toEqual({ version: 'v1.0.2' });
  });

  it('gates stop behind a confirmation', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], { f1: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop Crystal Lattice' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop Crystal Lattice' }));
    expect(actionCalls).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop forge' }));

    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0]!.url).toContain('/api/deployments/f1/stop');
  });

  it('leaves the forge running when the stop confirmation is dismissed', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING], { f1: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop Crystal Lattice' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop Crystal Lattice' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop forge' })).not.toBeInTheDocument(),
    );
    expect(actionCalls).toHaveLength(0);
  });

  it('starts a stopped forge immediately, without a confirmation', async () => {
    vi.stubGlobal('fetch', mockFetch([STOPPED], { f5: ['v1.1.0', 'v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('stopped')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Start Halted' }));

    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0]!.url).toContain('/api/deployments/f5/start');
    expect(actionCalls[0]!.body).toBeNull();
  });

  it('reads stopping while a disabled forge is still up', async () => {
    vi.stubGlobal('fetch', mockFetch([STOPPING], { f6: ['v1.0.2'] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('stopping')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start Winding Down' })).toBeInTheDocument();
  });

  it('offers neither start nor stop for a forge that was never deployed', async () => {
    vi.stubGlobal('fetch', mockFetch([NO_IMAGE], { f3: [] }));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('no image')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^(Start|Stop) / })).not.toBeInTheDocument();
  });

  it('surfaces the reason when the start route refuses', async () => {
    vi.stubGlobal('fetch', mockFetch(
      [STOPPED],
      { f5: ['v1.0.2'] },
      { ok: false, error: 'Cannot start a forge with no version pinned' },
    ));
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('stopped')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Start Halted' }));

    await waitFor(() =>
      expect(screen.getByText(/no version pinned/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Start Halted' })).toBeInTheDocument();
  });
});
