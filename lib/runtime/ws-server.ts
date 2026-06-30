import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import type { AppendMessageFn } from './transcript-watcher';
import { startContainerTranscriptWatcher, transcriptExists } from './container-transcript-watcher';
import { appendMessage as defaultAppend, ensureClaudeSessionId as defaultEnsureClaudeSessionId, loadConversationLite } from '@/lib/services/conversations';
import type { ConversationLite } from '@/lib/services/conversations';
import { CONTAINER_WORKDIR } from './paths';
import { loadRuntimeHandle as defaultLoadRuntimeHandle } from './state';
import { claudeCredentialsEnv } from './claude-credentials';

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, containerId: string, sessionId: string, deps: { appendMessage: AppendMessageFn }) => { stop: () => void };
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
  loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number } | null>;
  appendMessage?: AppendMessageFn;
  ensureClaudeSessionId?: (conversationId: string) => Promise<string>;
  sessionExists?: (containerId: string, sessionId: string) => Promise<boolean>;
};

type ActiveSession = { ws: WebSocket; pty: Session; watcher: { stop: () => void } };

/**
 * One PTY per WS connection: spawn `docker exec … claude` straight into a PTY and
 * stream it to the browser (no tmux indirection). The Claude session id is pinned
 * per conversation, so a reconnect resumes the same transcript (`--resume`) while a
 * first connect starts it with that exact id (`--session-id`). The session lives
 * for the connection — closing the socket ends the PTY; reopening resumes.
 */
export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, containerId, sessionId, deps) => startContainerTranscriptWatcher(cid, containerId, sessionId, deps));
  const appendMessage = opts.appendMessage ?? defaultAppend;
  const ensureClaudeSessionId = opts.ensureClaudeSessionId ?? defaultEnsureClaudeSessionId;
  const sessionExists = opts.sessionExists ?? transcriptExists;
  const loadConversation = opts.loadConversation ?? loadConversationLite;
  const loadForgeHandle = opts.loadRuntimeHandle ?? defaultLoadRuntimeHandle;

  const sessions = new Map<string, ActiveSession>();
  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const payload = verifyTicket(token, opts.secret);
    if (!payload) { ws.close(4401, 'Invalid or expired ticket'); return; }
    const cid = payload.conversationId;
    if (sessions.has(cid)) { ws.close(4409, 'Conversation already active'); return; }
    const conv = await loadConversation(cid);
    if (!conv) { ws.close(4404, 'Conversation not found'); return; }
    const handle = await loadForgeHandle(conv.forgeId);
    if (!handle) { ws.close(4404, 'Forge runtime not found'); return; }

    try {
      // Pinned per-conversation session id keys the transcript file the watcher
      // tails AND the claude invocation: resume if it already ran, else start it.
      const sessionId = conv.claudeSessionId ?? await ensureClaudeSessionId(cid);
      const resumable = await sessionExists(handle.containerId, sessionId);
      const sessionArgs = resumable ? ['--resume', sessionId] : ['--session-id', sessionId];

      const credFlags: string[] = [];
      for (const [k, v] of Object.entries(claudeCredentialsEnv())) credFlags.push('-e', `${k}=${v}`);
      const pty = spawnPty({
        command: 'docker',
        args: ['exec', '-i', '-t', '-w', CONTAINER_WORKDIR, ...credFlags,
               handle.containerId, 'claude', '--dangerously-skip-permissions', ...sessionArgs],
        cwd: '/', cols: 80, rows: 24,
      });
      const watcher = startWatcher(cid, handle.containerId, sessionId, { appendMessage });
      const active: ActiveSession = { ws, pty, watcher };
      sessions.set(cid, active);

      pty.onData((chunk) => { try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ } });
      pty.onExit((code) => {
        watcher.stop();
        sessions.delete(cid);
        try { ws.close(4000, `pty exit ${code}`); } catch { /* already closed */ }
      });
      ws.on('message', (raw, isBinary) => {
        if (isBinary) { pty.write(raw as Buffer); return; }
        const text = raw.toString('utf8');
        try {
          const msg = JSON.parse(text) as { type?: string };
          if (msg.type === 'input' && typeof (msg as { data?: unknown }).data === 'string') {
            pty.write((msg as { data: string }).data); return;
          }
          if (msg.type === 'resize') {
            const m = msg as { cols?: number; rows?: number };
            if (typeof m.cols === 'number' && typeof m.rows === 'number') pty.resize(m.cols, m.rows);
            return;
          }
        } catch { /* not JSON — fall through to raw write */ }
        pty.write(text);
      });
      ws.on('close', () => {
        pty.kill();
        watcher.stop();
        sessions.delete(cid);
      });
    } catch (err) {
      console.error('[runtime/ws] session setup failed', err);
      try { ws.close(4500, 'Failed to start session'); } catch { /* noop */ }
    }
  });

  return new Promise<{ stop: () => void; port: number }>((resolve) => {
    http.listen(opts.port, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        stop: () => {
          for (const s of sessions.values()) {
            try { s.ws.close(); } catch { /* noop */ }
            s.pty.kill(); s.watcher.stop();
          }
          sessions.clear();
          wss.close();
          http.close();
        },
      });
    });
  });
}
