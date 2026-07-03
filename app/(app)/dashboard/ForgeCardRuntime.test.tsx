import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCardRuntime, ForgeRuntimeActions, RuntimeStatus } from './ForgeCardRuntime';

const actionProps = {
  canWrite: true,
  onAction: vi.fn(),
};

beforeEach(() => actionProps.onAction.mockReset());

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

describe('ForgeRuntimeActions', () => {
  it('renders an enabled Start button when there is no runtime', () => {
    render(<ForgeRuntimeActions {...actionProps} runtime={null} />);
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('renders Open + Stop when status is running', () => {
    render(
      <ForgeRuntimeActions
        {...actionProps}
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
      <ForgeRuntimeActions
        {...actionProps}
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
    render(<ForgeRuntimeActions {...actionProps} runtime={null} />);
    await user.click(screen.getByRole('button', { name: /start/i }));
    expect(actionProps.onAction).toHaveBeenCalledWith('start');
  });

  it('renders nothing when canWrite is false and the forge is not running', () => {
    render(<ForgeRuntimeActions {...actionProps} canWrite={false} runtime={null} />);
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });
});

describe('ForgeCardRuntime', () => {
  it('renders a repo link and delete button when those props are provided', () => {
    const onDelete = vi.fn();
    render(
      <ForgeCardRuntime
        forgeName="Marketing Fru Fru"
        canWrite
        repoUrl="https://github.com/x/y"
        onDelete={onDelete}
      />,
    );
    expect(screen.getByRole('link', { name: /view on github/i })).toHaveAttribute('href', 'https://github.com/x/y');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });
});
