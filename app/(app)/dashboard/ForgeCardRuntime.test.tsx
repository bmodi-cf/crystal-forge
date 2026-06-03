import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgeCardRuntime } from './ForgeCardRuntime';

const baseProps = {
  forgeId: 'f1',
  forgeName: 'Marketing Fru Fru',
  canWrite: true,
  onAction: vi.fn(),
};

beforeEach(() => baseProps.onAction.mockReset());

describe('ForgeCardRuntime', () => {
  it('renders Stopped + Start when there is no runtime', () => {
    render(<ForgeCardRuntime {...baseProps} runtime={null} />);
    expect(screen.getByText(/Stopped/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('renders Running + Open + Stop when status is running', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 'marketing-frufru', status: 'running',
          containerId: 'c1', port: 3007, startedAt: '2026-05-09T00:00:00.000Z', logPath: '/tmp/x',
        }}
      />,
    );
    expect(screen.getByText(/Running/i)).toBeInTheDocument();
    const open = screen.getByRole('link', { name: /open/i });
    expect(open).toHaveAttribute('href', '/app/marketing-frufru/');
    expect(screen.getByRole('button', { name: /stop/i })).toBeEnabled();
  });

  it('renders Crashed + retry-Start with the log path', () => {
    render(
      <ForgeCardRuntime
        {...baseProps}
        runtime={{
          forgeId: 'f1', slug: 's', status: 'crashed',
          containerId: 'c1', port: 3007, startedAt: 'x', logPath: '/tmp/log',
        }}
      />,
    );
    expect(screen.getByText(/Crashed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
    expect(screen.getByText('/tmp/log')).toBeInTheDocument();
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
});
