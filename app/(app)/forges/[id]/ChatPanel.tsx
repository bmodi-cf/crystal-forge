'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

  // onData/send/resize are stable useCallbacks from useChatSession.
  const { onData, send, resize } = session;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Fit the display to the host AND push that size to the PTY so Claude's TTY
  // matches what the user sees (SIGWINCH). resize() is a no-op until the socket
  // is open, which is why we also call this when status flips to 'open' below.
  const syncSize = useCallback(() => {
    const term = termRef.current, fit = fitRef.current;
    if (!term || !fit) return;
    try { fit.fit(); resize(term.cols, term.rows); } catch { /* host not measurable yet */ }
  }, [resize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!conversationId || !host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0c0e12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    syncSize();
    // Re-fit on real host size changes, after fonts load (line-height changes),
    // and on a couple of deferred ticks once layout settles.
    const ro = new ResizeObserver(() => syncSize());
    ro.observe(host);
    const timers = [setTimeout(syncSize, 60), setTimeout(syncSize, 300)];
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => syncSize()).catch(() => {});
    }
    const dataDispose = term.onData((data) => send(data));
    const unsub = onData((chunk) => term.write(chunk));
    return () => {
      timers.forEach(clearTimeout);
      ro.disconnect();
      dataDispose.dispose();
      unsub();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [conversationId, onData, send, syncSize]);

  // The first resize during mount is dropped (socket not open yet), leaving the
  // PTY at its 80x24 spawn size — Claude then renders into only part of the
  // column. Re-send the size the moment the socket opens.
  useEffect(() => {
    if (session.status === 'open') syncSize();
  }, [session.status, syncSize]);

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
    <div className="flex flex-col h-full min-h-0">
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

      <div data-testid="xterm-host" ref={hostRef} className="flex-1 min-h-0 overflow-hidden bg-[#0c0e12]" />
    </div>
  );
}
