import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { verifyTicket } from '@/lib/auth/ws-ticket';
import { spawnClaudeSession, type Session, type SpawnOpts } from './pty-session';
import type { AppendMessageFn } from './transcript-watcher';
import { startContainerTranscriptWatcher } from './container-transcript-watcher';
import { appendMessage as defaultAppend, ensureClaudeSessionId as defaultEnsureClaudeSessionId, loadConversationLite } from '@/lib/services/conversations';
import type { ConversationLite } from '@/lib/services/conversations';
import { loadRuntimeHandle as defaultLoadRuntimeHandle } from './state';
import {
  ensureSession as defaultEnsureSession,
  hasSession as defaultHasSession,
  attachArgv as defaultAttachArgv,
} from './tmux-session';
import { sessionRegistry, type SessionRegistry } from './session-registry';

export type WsServerOpts = {
  port: number;
  secret: string;
  spawnPty?: (opts: SpawnOpts) => Session;
  startWatcher?: (conversationId: string, containerId: string, sessionId: string, deps: { appendMessage: AppendMessageFn }) => { stop: () => void };
  loadConversation?: (conversationId: string) => Promise<ConversationLite | null>;
  loadRuntimeHandle?: (forgeId: string) => Promise<{ containerId: string; port: number } | null>;
  appendMessage?: AppendMessageFn;
  ensureClaudeSessionId?: (conversationId: string) => Promise<string>;
  ensureSession?: (opts: { containerId: string; conversationId: string; sessionId: string }) => Promise<{ created: boolean }>;
  hasSession?: (containerId: string, conversationId: string) => Promise<boolean>;
  attachArgv?: (containerId: string, conversationId: string) => { command: string; args: string[] };
  registry?: SessionRegistry;
};

export function startWsServer(opts: WsServerOpts): Promise<{ stop: () => void; port: number }> {
  const spawnPty = opts.spawnPty ?? spawnClaudeSession;
  const startWatcher = opts.startWatcher
    ?? ((cid, containerId, sessionId, deps) => startContainerTranscriptWatcher(cid, containerId, sessionId, deps));
  const appendMessage = opts.appendMessage ?? defaultAppend;
  const ensureClaudeSessionId = opts.ensureClaudeSessionId ?? defaultEnsureClaudeSessionId;
  const loadConversation = opts.loadConversation ?? loadConversationLite;
  const loadForgeHandle = opts.loadRuntimeHandle ?? defaultLoadRuntimeHandle;
  const ensureSession = opts.ensureSession ?? defaultEnsureSession;
  const hasSession = opts.hasSession ?? defaultHasSession;
  const attachArgv = opts.attachArgv ?? defaultAttachArgv;
  const registry = opts.registry ?? sessionRegistry();

  // Serialize concurrent connects for the same conversation so the
  // has-session -> ensure -> attach sequence is atomic.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const payload = verifyTicket(token, opts.secret);
    if (!payload) { ws.close(4401, 'Invalid or expired ticket'); return; }
    const cid = payload.conversationId;

    void withLock(cid, async () => {
      try {
        const conv = await loadConversation(cid);
        if (!conv) { ws.close(4404, 'Conversation not found'); return; }
        const handle = await loadForgeHandle(conv.forgeId);
        if (!handle) { ws.close(4404, 'Forge runtime not found'); return; }

        // Takeover: detach any socket currently attached for this conversation.
        const prior = registry.get(cid);
        if (prior?.attachedWs && prior.attachedWs !== ws) {
          try { prior.attachedWs.close(4410, 'Superseded by a newer connection'); } catch { /* noop */ }
          prior.attachedWs = null;
        }
        // Stale entry from a previous container (forge stop/start): drop it.
        if (prior && prior.containerId !== handle.containerId) {
          prior.watcher.stop();
          registry.delete(cid);
        }

        // The conversation's Claude session id is pinned (set at create; this
        // backfills legacy rows). It keys both `claude --session-id/--resume` and
        // the single transcript file the watcher tails, so a new conversation
        // never picks up another session's history.
        const sessionId = conv.claudeSessionId ?? await ensureClaudeSessionId(cid);

        // Ensure a live tmux session + a session-scoped watcher exist.
        let entry = registry.get(cid);
        if (!entry) {
          await ensureSession({ containerId: handle.containerId, conversationId: cid, sessionId });
          const watcher = startWatcher(cid, handle.containerId, sessionId, { appendMessage });
          entry = { containerId: handle.containerId, watcher, attachedWs: null };
          registry.set(cid, entry);
        } else if (!(await hasSession(handle.containerId, cid))) {
          // Claude exited but the entry lingered — recreate from scratch.
          entry.watcher.stop();
          await ensureSession({ containerId: handle.containerId, conversationId: cid, sessionId });
          entry.watcher = startWatcher(cid, handle.containerId, sessionId, { appendMessage });
        }

        const { command, args } = attachArgv(handle.containerId, cid);
        const pty = spawnPty({ command, args, cwd: '/', cols: 80, rows: 24 });
        const active = entry;
        active.attachedWs = ws;

        pty.onData((chunk) => { try { ws.send(chunk, { binary: false }); } catch { /* socket closed */ } });
        pty.onExit(() => {
          // The attach *client* exited (detach). Leave the session + watcher alone.
          if (active.attachedWs === ws) active.attachedWs = null;
          try { ws.close(4000, 'tmux client exited'); } catch { /* already closed */ }
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
          } catch { /* not JSON — raw write */ }
          pty.write(text);
        });
        ws.on('close', () => {
          pty.kill(); // detaches the tmux client; claude + watcher keep running
          if (active.attachedWs === ws) active.attachedWs = null;
        });
      } catch (err) {
        // tmux missing (un-rebuilt image), docker exec failure, etc.
        console.error('[runtime/ws] session setup failed', err);
        try { ws.close(4500, 'Failed to start session'); } catch { /* noop */ }
      }
    });
  });

  return new Promise<{ stop: () => void; port: number }>((resolve) => {
    http.listen(opts.port, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        stop: () => {
          // Process teardown only: detach sockets. Sessions live in containers.
          for (const entry of registry.values()) {
            try { entry.attachedWs?.close(); } catch { /* noop */ }
            entry.attachedWs = null;
          }
          wss.close();
          http.close();
        },
      });
    });
  });
}
