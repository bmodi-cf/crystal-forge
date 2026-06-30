'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useChatSession, type ChatStatus } from './useChatSession';

type Props = {
  forgeId: string;
  conversationId: string | null;
};

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
  error: 'Error',
};

const AUTH_URL_RE = /https:\/\/\S*claude\.ai\S*/;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function ChatPanel({ forgeId, conversationId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = useChatSession(forgeId, conversationId);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  // Mount the xterm terminal on the live PTY stream. onData/send/resize are
  // stable useCallbacks, so this runs once per conversation (no destroy/recreate
  // cycle when status changes).
  const { onData, send, resize } = session;
  useEffect(() => {
    if (!conversationId || !hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0c0e12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // Defer the first fit until the flex layout has settled, else cols/rows are
    // measured against an unsized container.
    const raf = requestAnimationFrame(() => { fit.fit(); resize(term.cols, term.rows); });
    const onResize = () => { fit.fit(); resize(term.cols, term.rows); };
    window.addEventListener('resize', onResize);
    const dataDispose = term.onData((data) => send(data));
    const unsub = onData((chunk) => term.write(chunk));
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      dataDispose.dispose();
      unsub();
      term.dispose();
    };
  }, [conversationId, onData, send, resize]);

  // Surface the Claude Code auth URL (login inside the forge) as a banner.
  useEffect(() => {
    if (session.status !== 'open') return;
    return session.onData((chunk) => {
      const match = AUTH_URL_RE.exec(chunk.replace(ANSI_RE, ''));
      if (match) setAuthUrl(match[0]);
    });
  }, [session.status, session.onData]);

  if (!conversationId) {
    return (
      <div className="grid place-items-center h-full p-6 text-ink-faint text-[12px]">
        Select or start a conversation to begin.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-ink-faint shrink-0">
        <span>{STATUS_LABEL[session.status]}</span>
        <div className="flex items-center gap-3">
          {session.errorMessage ? <span className="text-[#d96868]">{session.errorMessage}</span> : null}
          <button
            type="button"
            onClick={() => { void session.end(); }}
            disabled={session.status !== 'open'}
            className="px-2 py-0.5 rounded border border-border text-ink-faint hover:text-ink disabled:opacity-40"
          >
            End session
          </button>
        </div>
      </div>

      {authUrl && (
        <div className="shrink-0 flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2 text-[11px]">
          <span className="text-ink-faint">Authentication required:</span>
          <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline break-all hover:text-blue-300">
            {authUrl}
          </a>
          <button type="button" onClick={() => setAuthUrl(null)} className="ml-auto shrink-0 text-ink-faint hover:text-ink" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div data-testid="xterm-host" ref={hostRef} className="flex-1 overflow-hidden bg-[#0c0e12]" />
    </div>
  );
}
