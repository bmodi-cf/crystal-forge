// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import type { ChatStatus } from './useChatSession';

global.ResizeObserver = class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); } as unknown as typeof ResizeObserver;

// Capture the xterm instance + its keystroke handler so we can drive the wiring.
let lastTerm: { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } | null = null;
let termKeyHandler: ((data: string) => void) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    write = vi.fn();
    dispose = vi.fn();
    loadAddon() {}
    open() {}
    onData(cb: (data: string) => void) { termKeyHandler = cb; return { dispose: vi.fn() }; }
    constructor() { lastTerm = this as unknown as { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const mockSession = {
  status: 'idle' as ChatStatus,
  errorMessage: null as string | null,
  send: vi.fn(),
  resize: vi.fn(),
  onData: vi.fn((_h: (chunk: string) => void) => () => {}),
  end: vi.fn(async () => {}),
};

vi.mock('./useChatSession', () => ({
  useChatSession: vi.fn(() => mockSession),
}));

async function withSession(overrides: Partial<typeof mockSession>) {
  const { useChatSession } = await import('./useChatSession');
  (useChatSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({ ...mockSession, ...overrides });
}

describe('ChatPanel (xterm terminal)', () => {
  beforeEach(() => { vi.clearAllMocks(); lastTerm = null; termKeyHandler = null; });

  it('shows empty state when conversationId is null', () => {
    render(<ChatPanel forgeId="f1" conversationId={null} />);
    expect(screen.getByText(/select or start a conversation/i)).toBeInTheDocument();
  });

  it('mounts the xterm terminal host when a conversation is selected', () => {
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByTestId('xterm-host')).toBeInTheDocument();
    expect(lastTerm).not.toBeNull();
  });

  it('writes incoming PTY data to the terminal', async () => {
    let dataHandler: ((chunk: string) => void) | null = null;
    await withSession({ onData: vi.fn((h: (chunk: string) => void) => { dataHandler = h; return () => {}; }) });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    act(() => { dataHandler?.('\x1b[32mhello\x1b[0m'); });
    expect(lastTerm?.write).toHaveBeenCalledWith('\x1b[32mhello\x1b[0m');
  });

  it('forwards terminal keystrokes to session.send', async () => {
    const send = vi.fn();
    await withSession({ send });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    act(() => { termKeyHandler?.('x'); });
    expect(send).toHaveBeenCalledWith('x');
  });

  it('shows Connected when status is open', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('calls session.end when End session clicked while open', async () => {
    const end = vi.fn(async () => {});
    await withSession({ status: 'open', end });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(end).toHaveBeenCalled();
  });

  it('shows auth banner when the PTY emits a claude.ai URL', async () => {
    let handler: ((chunk: string) => void) | null = null;
    await withSession({ status: 'open', onData: vi.fn((h: (chunk: string) => void) => { handler = h; return () => {}; }) });
    render(<ChatPanel forgeId="f1" conversationId="c1" />);
    act(() => { handler?.('Visit https://claude.ai/oauth/abc to login\r\n'); });
    expect(await screen.findByText(/authentication required/i)).toBeInTheDocument();
  });
});
