'use client';

import { useEffect, useRef, useState } from 'react';
import { useChatSession, type ChatStatus } from './useChatSession';
import { useConversationMessages } from './useConversationMessages';
import { MessageHistory } from './MessageHistory';
import { MessageInput } from './MessageInput';
import { ToolFeed } from './ToolFeed';

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
const TOOL_LINE_RE = /\b(Read|Write|Edit|Bash|WebFetch|Agent|TodoRead|TodoWrite|Glob|Grep|NotebookRead|NotebookEdit)\s*\(/;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function ChatPanel({ forgeId, conversationId }: Props) {
  const session = useChatSession(forgeId, conversationId);
  const { messages } = useConversationMessages(forgeId, conversationId, session.status === 'open');
  const [isWorking, setIsWorking] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const prevMsgCountRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Detect end-of-work: a new assistant message landed in the DB
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (messages.length > prevMsgCountRef.current && last?.role === 'assistant') {
      setIsWorking(false);
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  // Detect tool activity and auth URLs from PTY stream
  useEffect(() => {
    if (session.status !== 'open') return;
    return session.onData((chunk) => {
      const plain = chunk.replace(ANSI_RE, '');
      if (TOOL_LINE_RE.test(plain)) setIsWorking(true);
      const match = AUTH_URL_RE.exec(plain);
      if (match) setAuthUrl(match[0]);
    });
  }, [session.status, session.onData]);

  // Scroll to bottom when tool feed updates or new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isWorking]);

  function handleSend(text: string) {
    session.send(text + '\r');
    setIsWorking(true);
  }

  function handleInterrupt() {
    session.send('\x1b');
    setIsWorking(false);
  }

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

      {/* auth banner */}
      {authUrl && (
        <div className="shrink-0 flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2 text-[11px]">
          <span className="text-ink-faint">Authentication required:</span>
          <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline break-all hover:text-blue-300">
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

      {/* scrollable message area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <MessageHistory messages={messages} />
        <ToolFeed onData={session.onData} isWorking={isWorking} />
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <MessageInput
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isWorking={isWorking}
      />
    </div>
  );
}
