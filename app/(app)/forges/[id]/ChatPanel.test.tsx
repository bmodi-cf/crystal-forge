// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import type { ChatStatus } from './useChatSession';

global.ResizeObserver = class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); } as unknown as typeof ResizeObserver;

// Capture the xterm instance + its keystroke handler so we can drive the wiring.
let lastTerm: { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } | null = null;
let termKeyHandler: ((data: string) => void) | null = null;
let lastOnUploaded: ((p: string) => void) | null = null;
let uploadItems: import('./useUploads').UploadItem[] = [];
const uploadStart = vi.fn();
const uploadCancel = vi.fn();
const uploadDismiss = vi.fn();

vi.mock('./useUploads', () => ({
  useUploads: vi.fn((_forgeId: string, onUploaded: (p: string) => void) => {
    lastOnUploaded = onUploaded;
    return { items: uploadItems, start: uploadStart, cancel: uploadCancel, dismiss: uploadDismiss };
  }),
}));

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
  beforeEach(() => {
    vi.clearAllMocks(); lastTerm = null; termKeyHandler = null;
    lastOnUploaded = null; uploadItems = [];
  });

  it('shows empty state when conversationId is null', () => {
    render(<ChatPanel forgeId="f1" conversationId={null} canUpload={false} />);
    expect(screen.getByText(/select or start a conversation/i)).toBeInTheDocument();
  });

  it('mounts the xterm terminal host when a conversation is selected', () => {
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    expect(screen.getByTestId('xterm-host')).toBeInTheDocument();
    expect(lastTerm).not.toBeNull();
  });

  it('writes incoming PTY data to the terminal', async () => {
    let dataHandler: ((chunk: string) => void) | null = null;
    await withSession({ onData: vi.fn((h: (chunk: string) => void) => { dataHandler = h; return () => {}; }) });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    act(() => { dataHandler?.('\x1b[32mhello\x1b[0m'); });
    expect(lastTerm?.write).toHaveBeenCalledWith('\x1b[32mhello\x1b[0m');
  });

  it('forwards terminal keystrokes to session.send', async () => {
    const send = vi.fn();
    await withSession({ send });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    act(() => { termKeyHandler?.('x'); });
    expect(send).toHaveBeenCalledWith('x');
  });

  it('shows Connected when status is open', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('calls session.end when End session clicked while open', async () => {
    const end = vi.fn(async () => {});
    await withSession({ status: 'open', end });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    fireEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(end).toHaveBeenCalled();
  });

  it('shows auth banner when the PTY emits a claude.ai URL', async () => {
    let handler: ((chunk: string) => void) | null = null;
    await withSession({ status: 'open', onData: vi.fn((h: (chunk: string) => void) => { handler = h; return () => {}; }) });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    act(() => { handler?.('Visit https://claude.ai/oauth/abc to login\r\n'); });
    expect(await screen.findByText(/authentication required/i)).toBeInTheDocument();
  });
});

describe('ChatPanel uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks(); lastOnUploaded = null; uploadItems = [];
  });

  it('disables the paperclip when canUpload is false', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    expect(screen.getByRole('button', { name: /upload files/i })).toBeDisabled();
  });

  it('enables the paperclip when canUpload is true', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    expect(screen.getByRole('button', { name: /upload files/i })).toBeEnabled();
  });

  it('starts an upload for dropped files', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    const zone = screen.getByTestId('upload-dropzone');
    const f = new File(['x'], 'logo.png');
    fireEvent.drop(zone, { dataTransfer: { files: [f], types: ['Files'] } });
    expect(uploadStart).toHaveBeenCalledWith([f]);
  });

  it('ignores dropped files when canUpload is false', async () => {
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload={false} />);
    fireEvent.drop(screen.getByTestId('upload-dropzone'), {
      dataTransfer: { files: [new File(['x'], 'logo.png')], types: ['Files'] },
    });
    expect(uploadStart).not.toHaveBeenCalled();
  });

  it('writes the resolved path into the PTY with a trailing space and no newline', async () => {
    const send = vi.fn();
    await withSession({ status: 'open', send });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    act(() => { lastOnUploaded?.('uploads/logo.png'); });
    expect(send).toHaveBeenCalledWith('uploads/logo.png ');
    expect(send).not.toHaveBeenCalledWith(expect.stringContaining('\n'));
  });

  it('does not send to a closed session', async () => {
    const send = vi.fn();
    await withSession({ status: 'closed', send });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    act(() => { lastOnUploaded?.('uploads/logo.png'); });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders in-flight and failed upload lines', async () => {
    uploadItems = [
      { key: 1, name: 'big.bin', percent: 42, status: 'uploading' },
      { key: 2, name: 'bad.bin', percent: 0, status: 'error', error: 'Network error' },
    ];
    await withSession({ status: 'open' });
    render(<ChatPanel forgeId="f1" conversationId="c1" canUpload />);
    expect(screen.getByText(/big\.bin/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });
});
