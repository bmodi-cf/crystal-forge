import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PromotionsClient } from './PromotionsClient';

type Gate = { name: string; status: string; conclusion: string | null };

const GREEN: Gate[] = ['build', 'typecheck', 'lint', 'tests'].map((name) => ({
  name, status: 'completed', conclusion: 'success',
}));

function promotion(over: Record<string, unknown> = {}, summaryOver: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    forgeId: 'f1',
    status: 'checks_running',
    targetVersion: 'v1.2.0',
    prUrl: 'https://github.com/o/r/pull/4',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    requestedBy: { name: 'Bhadresh' },
    summary: {
      forgeName: 'Crystal Lattice',
      commits: 6,
      changedFiles: 28,
      gates: GREEN,
      mergeable: true,
      ...summaryOver,
    },
    ...over,
  };
}

function serve(promotions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ promotions }),
  })));
}

describe('PromotionsClient', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('renders a gate chip per check when the gates have reported', async () => {
    serve([promotion()]);
    render(<PromotionsClient />);

    expect(await screen.findByText('build: success')).toBeInTheDocument();
    expect(screen.getByText('tests: success')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The crystal-lattice PR #4 report: pending, no chips, "checks_running" — with
  // no hint that a merge conflict stopped GitHub from ever running the gates.
  it('explains a conflicted PR instead of showing an empty chip row', async () => {
    serve([promotion({ status: 'checks_running' }, { gates: [], mergeable: false })]);
    render(<PromotionsClient />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/merge conflict/i);
    expect(alert).toHaveTextContent(/will not run the promotion gates/i);
    expect(screen.getByText(/blocked — merge conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/no gate runs reported/i)).toBeInTheDocument();
  });

  it('flags gates that never started when no conflict explains the silence', async () => {
    serve([promotion({}, { gates: [], mergeable: true })]);
    render(<PromotionsClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/never started/i);
    expect(screen.getByText(/promote-gates\.yml/)).toBeInTheDocument();
  });

  it('keeps "waiting for gates to start" quiet during the grace period', async () => {
    serve([promotion({ createdAt: new Date().toISOString() }, { gates: [], mergeable: true })]);
    render(<PromotionsClient />);

    expect(await screen.findByText(/waiting for gates to start/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('enables Accept only for an unblocked, approved request', async () => {
    serve([promotion({ status: 'awaiting_approval' })]);
    render(<PromotionsClient />);

    expect(await screen.findByRole('button', { name: /accept/i })).toBeEnabled();
  });

  it('disables Accept on a conflicted request even when every gate is green', async () => {
    serve([promotion({ status: 'awaiting_approval' }, { mergeable: false })]);
    render(<PromotionsClient />);

    const accept = await screen.findByRole('button', { name: /accept/i });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute('title', expect.stringMatching(/conflict/i));
  });
});
