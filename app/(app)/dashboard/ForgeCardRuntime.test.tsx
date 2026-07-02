import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCardRuntime, RuntimeStatus } from './ForgeCardRuntime';

const baseProps = {
  forgeName: 'Marketing Fru Fru',
  canWrite: true,
  onAction: vi.fn(),
};

beforeEach(() => baseProps.onAction.mockReset());

describe('RuntimeStatus', () => {
  it('renders Stopped when there is no runtime', () => {
    render(<RuntimeStatus runtime={null} />);
    expect(screen.getByText(/Stopped/i)).toBeInTheDocument();
  });

  it('renders Running when status is running', () => {
    render(
      <RuntimeStatus
        runtime={{
          forgeId: 'f1', slug: 'marketing-frufru', status: 'running',
          containerId: 'c1', port: 3007, startedAt: '2026-05-09T00:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByText(/Running/i)).toBeInTheDocument();
  });

  it('renders the setup error (never a host path) when setup failed', () => {
    render(
      <RuntimeStatus
        runtime={{
          forgeId: 'f1', slug: 's', status: 'setup-failed',
          containerId: 'c1', port: 3007, startedAt: 'x',
          setupError: 'pnpm install failed (exit 1)',
        }}
      />,
    );
    expect(screen.getByText(/Setup failed/i)).toBeInTheDocument();
    expect(screen.getByText('pnpm install failed (exit 1)')).toBeInTheDocument();
    // Host paths must never reach the client.
    expect(screen.queryByText(/\/Users\/|\/tmp\//)).toBeNull();
  });
});

describe('ForgeCardRuntime', () => {
  it('renders an enabled Start button when there is no runtime', () => {
    render(<ForgeCardRuntime {...baseProps} runtime={null} />);
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('renders Open + Stop when status is running', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 'marketing-frufru', status: 'running',
          containerId: 'c1', port: 3007, startedAt: '2026-05-09T00:00:00.000Z',
        }}
      />,
    );
    const open = screen.getByRole('link', { name: /open/i });
    expect(open).toHaveAttribute('href', '/app/marketing-frufru/');
    expect(screen.getByRole('button', { name: /stop/i })).toBeEnabled();
  });

  it('offers a retry Start when setup failed', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 's', status: 'setup-failed',
          containerId: 'c1', port: 3007, startedAt: 'x',
          setupError: 'pnpm install failed (exit 1)',
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('start click invokes onAction("start")', async () => {
    const user = userEvent.setup();
    render(<ForgeCardRuntime {...baseProps} runtime={null} />);
    await user.click(screen.getByRole('button', { name: /start/i }));
    expect(baseProps.onAction).toHaveBeenCalledWith('start');
  });

  it('hides Start/Stop buttons when canWrite is false', () => {
    render(<ForgeCardRuntime {...baseProps} canWrite={false} runtime={null} />);
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
  });

  it('renders a repo link and delete button when those props are provided', () => {
    const onDelete = vi.fn();
    render(
      <ForgeCardRuntime {...baseProps} runtime={null} repoUrl="https://github.com/x/y" onDelete={onDelete} />,
    );
    expect(screen.getByRole('link', { name: /view on github/i })).toHaveAttribute('href', 'https://github.com/x/y');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });
});
