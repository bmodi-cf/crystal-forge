'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ChatStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type ChatSession = {
  status: ChatStatus;
  errorMessage: string | null;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Subscribe to incoming server bytes. */
  onData: (handler: (chunk: string) => void) => () => void;
  /** Explicitly end the durable server-side session. */
  end: () => Promise<void>;
};

export function useChatSession(forgeId: string, conversationId: string | null): ChatSession {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(chunk: string) => void>>(new Set());

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setStatus('connecting');
    setErrorMessage(null);
    (async () => {
      try {
        const res = await fetch(`/api/forges/${forgeId}/conversations/${conversationId}/connect`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `connect failed (${res.status})`);
        const body = (await res.json()) as { wsUrl: string; token: string };
        if (cancelled) return;
        const ws = new WebSocket(`${body.wsUrl}?token=${encodeURIComponent(body.token)}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus('open');
        ws.onmessage = (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : '';
          handlersRef.current.forEach((h) => h(text));
        };
        ws.onclose = (ev) => {
          if (ev.code === 4401) setErrorMessage('Authorization expired');
          else if (ev.code === 4410) setErrorMessage('Reconnected in another tab');
          else if (ev.code === 4411) setErrorMessage('Session ended');
          else if (ev.code === 4404) setErrorMessage('Conversation not found');
          else if (ev.code === 4500) setErrorMessage('Failed to start session');
          setStatus('closed');
        };
        ws.onerror = () => { setStatus('error'); setErrorMessage('WebSocket error'); };
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Failed to connect');
        }
      }
    })();
    return () => {
      cancelled = true;
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [forgeId, conversationId]);

  // All three functions use refs internally so they never need to change.
  const send = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }, []);

  const onData = useCallback((handler: (chunk: string) => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const end = useCallback(async () => {
    if (!conversationId) return;
    await fetch(`/api/forges/${forgeId}/conversations/${conversationId}/end`, { method: 'POST' });
    try { wsRef.current?.close(); } catch { /* noop */ }
  }, [forgeId, conversationId]);

  // Return a stable object — only changes when status/errorMessage change or
  // conversationId changes (which recreates `end`). This prevents effects in
  // ChatPanel that depend on the session reference from firing on every render.
  return useMemo(
    () => ({ status, errorMessage, send, resize, onData, end }),
    [status, errorMessage, send, resize, onData, end],
  );
}
