import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import { startTranscriptWatcher, type WatcherDeps } from './transcript-watcher';
import { appendMessage as defaultAppend, setClaudeSessionId as defaultSet } from '@/lib/services/conversations';
import { forgeClonePath as defaultForgeClonePath } from './paths';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { slugifyForgeName } from '@/lib/github/slug';

type ConversationLite = { id: string; slug: string; claudeSessionId: string | null };

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, cloneDir: string, deps: WatcherDeps) => { stop: () => void };
  forgeClonePath?: (slug: string) => string;
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
};

type ActiveSession = { ws: WebSocket; pty: Session; watcher: { stop: () => void } };

export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, dir, deps) => startTranscriptWatcher(cid, dir, deps));
  const forgeClonePath = opts.forgeClonePath ?? defaultForgeClonePath;
  const loadConversation = opts.loadConversation ?? (async (id) => {
    const row = await defaultPrisma.conversation.findUnique({
      where: { id },
      include: { forge: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      slug: slugifyForgeName(row.forge.name),
      claudeSessionId: row.claudeSessionId,
    };
  });

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

    const cwd = forgeClonePath(conv.slug);
    const pty = spawnPty({
      cwd, cols: 80, rows: 24,
      ...(conv.claudeSessionId ? { args: ['--resume', conv.claudeSessionId] } : {}),
    });
    const watcher = startWatcher(conv.id, cwd, {
      appendMessage: defaultAppend,
      setClaudeSessionId: defaultSet,
    });
    const active: ActiveSession = { ws, pty, watcher };
    sessions.set(conv.id, active);

    pty.onData((chunk) => {
      try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ }
    });
    pty.onExit((code) => {
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
