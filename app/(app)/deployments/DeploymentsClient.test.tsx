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

const deployCalls: Array<{ url: string; body: unknown }> = [];

function mockFetch(rows: DeploymentRow[], versions: Record<string, string[] | null>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/deployments')) {
      return { ok: true, json: async () => ({ deployments: rows }) };
    }
    if (url.endsWith('/api/deployments/versions')) {
      return { ok: true, json: async () => ({ versions }) };
    }
    deployCalls.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ deployment: rows[0] }) };
  });
}

beforeEach(() => { deployCalls.length = 0; });
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

    await waitFor(() => expect(deployCalls).toHaveLength(1));
    expect(deployCalls[0]!.url).toContain('/api/deployments/f1/deploy');
    expect(deployCalls[0]!.body).toEqual({ version: 'v1.1.0' });
  });
});
