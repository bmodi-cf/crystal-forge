import { loadRuntimeHandle } from './state';
import { killSession } from './tmux-session';
import { sessionRegistry } from './session-registry';

/**
 * Explicitly end a conversation's durable Claude session: kill the in-container
 * tmux server, stop its transcript watcher, close any attached socket, and drop
 * the registry entry. Safe to call when nothing is live.
 */
export async function endSession(forgeId: string, conversationId: string): Promise<void> {
  const handle = await loadRuntimeHandle(forgeId);
  if (handle) await killSession(handle.containerId, conversationId);

  const reg = sessionRegistry();
  const entry = reg.get(conversationId);
  if (entry) {
    entry.watcher.stop();
    try { entry.attachedWs?.close(4411, 'Session ended'); } catch { /* noop */ }
    reg.delete(conversationId);
  }
}
