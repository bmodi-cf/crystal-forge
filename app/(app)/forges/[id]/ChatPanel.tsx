'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Paperclip, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useChatSession, type ChatStatus } from './useChatSession';
import { useUploads } from './useUploads';

type Props = {
  forgeId: string;
  conversationId: string | null;
  /** False when the forge isn't running or the user lacks write access. */
  canUpload: boolean;
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

export function ChatPanel({ forgeId, conversationId, canUpload }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = useChatSession(forgeId, conversationId);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  // Held in a ref, and refreshed in an effect rather than during render, so
  // onUploaded stays referentially stable across status flips without tripping
  // the no-ref-writes-in-render rule.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const onUploaded = useCallback((path: string) => {
    // Type the path into Claude's prompt: trailing space, no newline, so the
    // user finishes the sentence and presses Enter themselves.
    if (sessionRef.current.status === 'open') sessionRef.current.send(`${path} `);
  }, []);
  const uploads = useUploads(forgeId, onUploaded);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadDisabledReason = canUpload ? null : 'Start the forge to upload files';

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (!canUpload) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) uploads.start(files);
  }

  // onData/send/resize are stable useCallbacks from useChatSession.
  const { onData, send, resize } = session;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastDims = useRef({ cols: 0, rows: 0 });

  // Fit the display to the host AND push that size to the PTY so Claude's TTY
  // matches what the user sees (SIGWINCH). resize() is a no-op until the socket
  // is open, which is why we also call this when status flips to 'open' below.
  // Dedupe on the *proposed* dims so a no-op fit can't mutate the DOM and
  // re-trigger the ResizeObserver — that feedback loop flooded the PTY with
  // resizes and kept Claude's TUI from settling.
  const syncSize = useCallback(() => {
    const term = termRef.current, fit = fitRef.current;
    if (!term || !fit) return;
    try {
      const dims = fit.proposeDimensions();
      if (!dims?.cols || !dims?.rows) return;
      if (dims.cols === lastDims.current.cols && dims.rows === lastDims.current.rows) return;
      lastDims.current = { cols: dims.cols, rows: dims.rows };
      fit.fit();
      resize(term.cols, term.rows);
    } catch { /* host not measurable yet */ }
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
    // Re-fit on real host size changes (debounced to coalesce bursts), after
    // fonts load (line-height changes), and on a couple of deferred ticks once
    // layout settles.
    let roTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(roTimer); roTimer = setTimeout(syncSize, 120); });
    ro.observe(host);
    const timers = [setTimeout(syncSize, 60), setTimeout(syncSize, 300)];
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => syncSize()).catch(() => {});
    }
    const dataDispose = term.onData((data) => send(data));
    const unsub = onData((chunk) => term.write(chunk));
    return () => {
      clearTimeout(roTimer);
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
            aria-label="Upload files"
            title={uploadDisabledReason ?? 'Upload files into uploads/'}
            disabled={!canUpload}
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-0.5 rounded border border-border text-ink-faint hover:text-ink disabled:opacity-40"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) uploads.start(files);
              e.target.value = '';
            }}
          />
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

      {uploads.items.length > 0 && (
        <div className="shrink-0 border-b border-border bg-surface-raised px-3 py-1.5 text-[11px]">
          {uploads.items.map((it) => (
            <div key={it.key} className="flex items-center gap-2">
              <span className="truncate text-ink-dim">{it.name}</span>
              {it.status === 'uploading' && <span className="text-ink-faint">{it.percent}%</span>}
              {it.status === 'done' && <span className="text-ink-faint">→ {it.path}</span>}
              {it.status === 'error' && <span className="text-[#d96868]">{it.error}</span>}
              <button
                type="button"
                aria-label={it.status === 'uploading' ? `Cancel ${it.name}` : `Dismiss ${it.name}`}
                onClick={() => (it.status === 'uploading' ? uploads.cancel(it.key) : uploads.dismiss(it.key))}
                className="ml-auto shrink-0 text-ink-faint hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hide the xterm scrollbar so its show/hide doesn't change content width
          and feed the resize loop; wheel-scroll still works. */}
      <style>{`.xterm-viewport::-webkit-scrollbar{width:0;height:0}.xterm-viewport{scrollbar-width:none}`}</style>
      <div
        data-testid="upload-dropzone"
        onDragOver={(e) => { e.preventDefault(); if (canUpload) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className="relative flex-1 min-h-0"
      >
        <div data-testid="xterm-host" ref={hostRef} className="h-full w-full overflow-hidden bg-[#0c0e12] p-1" />
        {dragging && canUpload && (
          <div className="pointer-events-none absolute inset-2 grid place-items-center rounded border-2 border-dashed border-border-strong bg-black/40 text-[12px] text-ink">
            Drop files into uploads/
          </div>
        )}
      </div>
    </div>
  );
}
