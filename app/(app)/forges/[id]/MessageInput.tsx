'use client';

import { useRef, useState } from 'react';

type Props = {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  isWorking: boolean;
};

const LINE_HEIGHT_PX = 20;
const MAX_ROWS = 6;

export function MessageInput({ onSend, onInterrupt, isWorking }: Props) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * LINE_HEIGHT_PX)}px`;
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    autoResize(e.target);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = value.trim();
    if (!text || isWorking) return;
    onSend(text);
    setValue('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
    }
  }

  return (
    <div className="border-t border-border px-3 py-2 flex flex-col gap-1.5 shrink-0">
      <textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={isWorking}
        placeholder={isWorking ? 'Claude is working…' : 'Type a message… (Enter to send, Shift+Enter for newline)'}
        rows={1}
        className="w-full resize-none bg-surface rounded border border-border px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-border-strong disabled:opacity-50 overflow-y-auto"
        style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
      />
      <div className="flex items-center justify-between text-[10px] text-ink-faint">
        <span>{isWorking ? '' : 'Shift+↵ newline'}</span>
        {isWorking ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="px-2.5 py-0.5 rounded border border-[#6e343d] text-[#ffa198] hover:bg-[#6e343d]/20 text-[10px]"
          >
            ■ Interrupt
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="px-2.5 py-0.5 rounded bg-[#238636] text-white text-[10px] hover:bg-[#2ea043] disabled:opacity-40"
          >
            Send ↵
          </button>
        )}
      </div>
    </div>
  );
}
