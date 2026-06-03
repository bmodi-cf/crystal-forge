import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import type { WatcherDeps } from './transcript-watcher';
import { startContainerTranscriptWatcher } from './container-transcript-watcher';
import { appendMessage as defaultAppend, setClaudeSessionId as defaultSet, loadConversationLite } from '@/lib/services/conversations';
import type { ConversationLite } from '@/lib/services/conversations';
import { CONTAINER_WORKDIR } from './paths';
import { loadRuntimeHandle as defaultLoadRuntimeHandle } from './state';
import { claudeCredentialsEnv } from './claude-credentials';

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, containerId: string, deps: WatcherDeps) => { stop: () => void };
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
  loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number } | null>;
  appendMessage?: (conversationId: string, payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date }) => Promise<void>;
  setClaudeSessionId?: (conversationId: string, sessionId: string) => Promise<void>;
};

type ActiveSession = { ws: WebSocket; pty: Session; watcher: { stop: () => void } };

export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, containerId, deps) => startContainerTranscriptWatcher(cid, containerId, deps));
  const appendMessage = opts.appendMessage ?? defaultAppend;
  const setClaudeSessionId = opts.setClaudeSessionId ?? defaultSet;
  const loadConversation = opts.loadConversation ?? loadConversationLite;
  const loadForgeHandle = opts.loadRuntimeHandle ?? defaultLoadRuntimeHandle;

  const sessions = new Map<string, ActiveSession>();
  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const token = url.searchParams.get('token') ?? '';
    const payload = verifyTicket(token, opts.secret);
    if (!payload) { ws.close(4401, 'Invalid or expired ticket'); return; }
    if (sessions.has(payload.conversationId)) { ws.close(4409, 'Conversation already active'); return; }
    const conv = await loadConversation(payload.conversationId);
    if (!conv) { ws.close(4404, 'Conversation not found'); return; }

    const handle = await loadForgeHandle(conv.forgeId);
    if (!handle) { ws.close(4404, 'Forge runtime not found'); return; }

    const credFlags: string[] = [];
    for (const [k, v] of Object.entries(claudeCredentialsEnv())) credFlags.push('-e', `${k}=${v}`);
    const resumeArgs = conv.claudeSessionId ? ['--resume', conv.claudeSessionId] : [];
    const pty = spawnPty({
      command: 'docker',
      args: ['exec', '-i', '-t', '-w', CONTAINER_WORKDIR, ...credFlags,
             handle.containerId, 'claude', '--dangerously-skip-permissions', ...resumeArgs],
      cwd: '/', cols: 80, rows: 24,
    });
    const watcher = startWatcher(conv.id, handle.containerId, {
      appendMessage,
      setClaudeSessionId,
    });
    const active: ActiveSession = { ws, pty, watcher };
    sessions.set(conv.id, active);

    pty.onData((chunk) => {
      try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ }
    });
    pty.onExit((code) => {
      watcher.stop();
      sessions.delete(conv.id);
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
      sessions.delete(conv.id);
    });
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
