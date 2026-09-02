// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageClient } from './UsageClient';

vi.mock('./charts', () => ({
  UsageCharts: () => <div data-testid="usage-charts" />,
}));

const SERIES = {
  range: '30d',
  bucketMs: 14_400_000,
  dockerBucketMs: 1_800_000,
  points: [{
    at: '2026-09-01T00:00:00.000Z',
    cpuPct: 37.4, cpuPeakPct: 91, iowaitPct: 4,
    memUsedBytes: 10_000_000_000, memPeakBytes: 12_000_000_000, memTotalBytes: 16_766_013_440,
    diskUsedBytes: 130_000_000_000, diskTotalBytes: 268_315_004_928, runningForges: 3,
  }],
  docker: [],
  latest: {
    at: '2026-09-01T00:00:00.000Z',
    cpuPct: 37.4,
    memUsedBytes: 10_000_000_000,
    memTotalBytes: 16_766_013_440,
    diskUsedBytes: 130_000_000_000,
    diskTotalBytes: 268_315_004_928,
    runningForges: 3,
    cpuCount: 1,
  },
};

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

beforeEach(() => { vi.stubGlobal('fetch', mockFetch({ series: SERIES })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('UsageClient', () => {
  it('requests the 30 day range by default and renders the tiles', async () => {
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByTestId('usage-charts')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith('/api/admin/usage?range=30d');
    expect(screen.getByText('37 %')).toBeInTheDocument();
    expect(screen.getByText(/9\.3 GiB/)).toBeInTheDocument();   // 10e9 bytes
    expect(screen.getByText(/121\.1 GiB/)).toBeInTheDocument(); // 130e9 bytes
    expect(screen.getByTestId('tile-forges')).toHaveTextContent('3');
  });

  it('refetches when the range changes', async () => {
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByTestId('usage-charts')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '24h' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/admin/usage?range=24h'),
    );
  });

  it('shows a collecting message when nothing has been sampled yet', async () => {
    vi.stubGlobal('fetch', mockFetch({ series: { ...SERIES, points: [], docker: [], latest: null } }));
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByText(/collecting/i)).toBeInTheDocument());
    expect(screen.queryByTestId('usage-charts')).not.toBeInTheDocument();
  });

  it('explains that CPU needs a second sample when only one exists', async () => {
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByTestId('usage-charts')).toBeInTheDocument());
    // The fixture carries a single point, so the note is shown alongside the
    // gauges — which are valid from one reading.
    expect(screen.getByText(/fills in after the next one/i)).toBeInTheDocument();
    expect(screen.getByTestId('tile-memory')).toHaveTextContent('9.3 GiB');
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Admin only' }, false));
    render(<UsageClient />);
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
  });
});
