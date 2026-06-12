'use client';

import { useEffect, useState } from 'react';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const TOOL_LINE_RE = /\b(Read|Write|Edit|Bash|WebFetch|Agent|TodoRead|TodoWrite|Glob|Grep|NotebookRead|NotebookEdit)\s*\(/;

type Props = {
  onData: (handler: (chunk: string) => void) => () => void;
  isWorking: boolean;
};

export function ToolFeed({ onData, isWorking }: Props) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!isWorking) { setLines([]); return; }
    return onData((chunk) => {
      const plain = chunk.replace(ANSI_RE, '');
      const matched = plain
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => TOOL_LINE_RE.test(l));
      if (matched.length > 0) {
        setLines((prev) => [...prev, ...matched].slice(-20));
      }
    });
  }, [isWorking, onData]);

  if (!isWorking || lines.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 px-3 py-1">
      {lines.map((line, i) => (
        <span key={i} className="text-[10px] text-ink-faint font-mono opacity-60">
          ⚙ {line}
        </span>
      ))}
      <span className="text-[10px] text-ink-faint font-mono opacity-40 animate-pulse">▌</span>
    </div>
  );
}
