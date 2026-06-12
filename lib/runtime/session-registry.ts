import type { WebSocket } from 'ws';

export type SessionEntry = {
  /** Container the live tmux session belongs to. */
  containerId: string;
  /** Transcript watcher, scoped to the session (not the socket). */
  watcher: { stop: () => void };
  /** The currently-attached browser socket, or null when detached. */
  attachedWs: WebSocket | null;
};

export type SessionRegistry = Map<string, SessionEntry>;

const globalForRegistry = globalThis as unknown as {
  __forgeSessionRegistry?: SessionRegistry;
};

/** Shared in-process registry of live Claude sessions, keyed by conversationId. */
export function sessionRegistry(): SessionRegistry {
  return (globalForRegistry.__forgeSessionRegistry ??= new Map());
}
