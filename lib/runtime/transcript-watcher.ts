import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AppendMessageFn = (
  conversationId: string,
  payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date },
) => Promise<void>;

export type SetClaudeSessionIdFn = (conversationId: string, sessionId: string) => Promise<void>;

export type WatcherDeps = {
  appendMessage: AppendMessageFn;
  setClaudeSessionId: SetClaudeSessionIdFn;
  /** Poll interval; default 250ms. */
  pollIntervalMs?: number;
};

/** Project-dir naming used by Claude Code: cwd with `/` and `.` → `-`. */
export function encodedCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function parseTranscriptLine(line: string): { sessionId: string; message: { role: 'user' | 'assistant'; content: unknown } } | null {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { sessionId?: unknown; message?: unknown };
  if (typeof o.sessionId !== 'string') return null;
  const msg = o.message as { role?: unknown; content?: unknown } | undefined;
  if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;
  return { sessionId: o.sessionId, message: { role: msg.role, content: msg.content } };
}

type TailHandle = { stop: () => void };

function tailJsonl(file: string, onLine: (line: string) => void, pollIntervalMs: number): TailHandle {
  let offset = 0;
  let buffer = '';
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  function poll() {
    if (stopped) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size > offset) {
        const fd = fs.openSync(file, 'r');
        try {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, offset);
          offset = stat.size;
          buffer += buf.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) onLine(line);
          }
        } finally { fs.closeSync(fd); }
      }
    } catch { /* file gone, etc. */ }
    if (!stopped) timer = setTimeout(poll, pollIntervalMs);
  }
  timer = setTimeout(poll, pollIntervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startTranscriptWatcher(
  conversationId: string,
  cloneDir: string,
  deps: WatcherDeps,
): { stop: () => void } {
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd(cloneDir));
  const t0 = Date.now();
  let tail: TailHandle | null = null;
  let stopped = false;
  let claimTimer: NodeJS.Timeout | null = null;

  function tryClaim() {
    if (stopped || tail) return;
    let bestFile: string | null = null;
    let bestMtime = -1;
    try {
      const entries = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      for (const f of entries) {
        const stat = fs.statSync(path.join(projectDir, f));
        const mtimeMs = stat.mtimeMs;
        if (mtimeMs >= t0 - 50 && mtimeMs > bestMtime) {
          bestMtime = mtimeMs;
          bestFile = path.join(projectDir, f);
        }
      }
    } catch { /* dir not yet created */ }

    if (bestFile) {
      let sessionRecorded = false;
      tail = tailJsonl(bestFile, (line) => {
        const parsed = parseTranscriptLine(line);
        if (!parsed) return;
        if (!sessionRecorded) {
          sessionRecorded = true;
          void Promise.resolve(deps.setClaudeSessionId(conversationId, parsed.sessionId)).catch(() => {});
        }
        void Promise.resolve(deps.appendMessage(conversationId, {
          role: parsed.message.role,
          content: parsed.message.content,
        })).catch(() => {});
      }, pollIntervalMs);
      return;
    }
    claimTimer = setTimeout(tryClaim, pollIntervalMs);
  }
  claimTimer = setTimeout(tryClaim, pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      if (claimTimer) clearTimeout(claimTimer);
      tail?.stop();
    },
  };
}
