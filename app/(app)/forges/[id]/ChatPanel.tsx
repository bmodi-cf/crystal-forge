'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useChatSession, type ChatStatus } from './useChatSession';
import { useConversationMessages } from './useConversationMessages';
import { ConversationHistory } from './ConversationHistory';

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

// Matches https URLs that Claude Code prints during the OAuth flow.
const AUTH_URL_RE = /https:\/\/\S+claude\.ai\S*/;

// Strip ANSI escape codes so we can grep plain text from the PTY stream.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function ChatPanel({ forgeId, conversationId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = useChatSession(forgeId, conversationId);
  const { messages } = useConversationMessages(forgeId, conversationId, session.status === 'open');
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  // Scan raw PTY output for the Claude Code auth URL and surface it as a
  // persistent banner — the terminal redraws on focus and the URL disappears.
  useEffect(() => {
    if (session.status !== 'open') return;
    return session.onData((chunk) => {
      const plain = chunk.replace(ANSI_RE, '');
      const match = AUTH_URL_RE.exec(plain);
      if (match) setAuthUrl(match[0]);
    });
  }, [session]);

  // Clear the auth banner once the user has actual conversation messages
  // (auth is done, Claude is running).
  useEffect(() => {
    if (messages.length > 0) setAuthUrl(null);
  }, [messages.length]);

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
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    const refit = () => { fit.fit(); session.resize(term.cols, term.rows); };
    const observer = new ResizeObserver(refit);
    observer.observe(hostRef.current);
    const timerId = setTimeout(refit, 0);
    const onWheel = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); };
    hostRef.current.addEventListener('wheel', onWheel, { passive: false, capture: true });
    const dataDispose = term.onData((data) => session.send(data));
    const unsub = session.onData((chunk) => term.write(chunk));
    return () => {
      clearTimeout(timerId);
      observer.disconnect();
      hostRef.current?.removeEventListener('wheel', onWheel, { capture: true });
      dataDispose.dispose();
      unsub();
      term.dispose();
    };
  }, [conversationId, session]);

  if (!conversationId) {
    return (
      <div className="grid place-items-center h-full p-6 text-ink-faint text-[12px]">
        Select or start a conversation to begin.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* status bar */}
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

      {/* auth banner — shown while Claude Code needs browser authentication */}
      {authUrl && (
        <div className="shrink-0 flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2 text-[11px]">
          <span className="text-ink-faint">Authentication required:</span>
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline break-all hover:text-blue-300"
          >
            {authUrl}
          </a>
          <button
            type="button"
            onClick={() => setAuthUrl(null)}
            className="ml-auto shrink-0 text-ink-faint hover:text-ink"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* conversation history — scrollable React view */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <ConversationHistory messages={messages} />
      </div>

      {/* live terminal strip */}
      <div className="shrink-0 h-[40%] border-t border-border">
        <div data-testid="xterm-host" ref={hostRef} className="h-full bg-[#0c0e12]" />
      </div>
    </div>
  );
}
