import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

vi.mock('./useChatSession', () => ({
  useChatSession: vi.fn(() => ({
    status: 'idle',
    errorMessage: null,
    send: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    end: vi.fn(async () => {}),
  })),
}));

// xterm uses browser APIs (matchMedia, WebGL, canvas) that jsdom does not
// implement. Mock the whole module so the component renders without errors.
vi.mock('@xterm/xterm', () => {
  const Terminal = vi.fn(function (this: Record<string, unknown>) {
    this.loadAddon = vi.fn();
    this.open = vi.fn();
    this.onData = vi.fn(() => ({ dispose: vi.fn() }));
    this.write = vi.fn();
    this.dispose = vi.fn();
    this.cols = 80;
    this.rows = 24;
  });
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  const FitAddon = vi.fn(function (this: Record<string, unknown>) {
    this.fit = vi.fn();
    this.dispose = vi.fn();
  });
  return { FitAddon };
});

describe('ChatPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an empty state when conversationId is null', () => {
    render(<ChatPanel forgeId="f1" conversationId={null} />);
    expect(screen.getByText(/select or start a conversation/i)).toBeInTheDocument();
  });

  it('mounts a terminal container when a conversation is selected', () => {
    const { container } = render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(container.querySelector('[data-testid="xterm-host"]')).toBeInTheDocument();
  });

  it('shows the connect status', async () => {
    const { useChatSession } = await import('./useChatSession');
    (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 'connecting',
      errorMessage: null,
      send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), end: vi.fn(async () => {}),
    });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('shows the error message when status=error', async () => {
    const { useChatSession } = await import('./useChatSession');
    (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 'error',
      errorMessage: 'WebSocket error',
      send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), end: vi.fn(async () => {}),
    });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByText(/WebSocket error/i)).toBeInTheDocument();
  });

  it('End session button calls session.end when connected', async () => {
    const end = vi.fn(async () => {});
    const { useChatSession } = await import('./useChatSession');
    (useChatSession as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      status: 'open', errorMessage: null,
      send: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), end,
    });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(end).toHaveBeenCalled();
  });
});
