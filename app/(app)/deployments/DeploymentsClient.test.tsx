// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DeploymentsClient } from './DeploymentsClient';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ deployments: [
      { forgeId: 'f1', slug: 'acme', name: 'Acme', desiredVersion: 'v1.2.3', runningVersion: 'v1.2.3', phase: 'running', error: null, consecutiveFailures: 0 },
      { forgeId: 'f2', slug: 'beta', name: 'Beta', desiredVersion: 'v2.0.0', runningVersion: null, phase: 'failed', error: 'pull failed', consecutiveFailures: 3 },
    ] }),
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('DeploymentsClient', () => {
  it('renders each deployment with its version, phase, and error', async () => {
    render(<DeploymentsClient />);
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    // Acme's pinned and running versions are both v1.2.3, so it renders twice.
    expect(screen.getAllByText('v1.2.3').length).toBeGreaterThan(0);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('pull failed')).toBeInTheDocument();
  });
});
