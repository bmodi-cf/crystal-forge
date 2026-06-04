import os from 'node:os';
import path from 'node:path';

export function forgeHome(): string {
  // Read live from process.env so tests can override CRYSTAL_FORGE_HOME per-run.
  return process.env.CRYSTAL_FORGE_HOME ?? path.join(os.homedir(), '.crystal-forge');
}

export function stateFilePath(): string {
  return path.join(forgeHome(), 'state.json');
}

export function clonesDir(): string {
  return path.join(forgeHome(), 'clones');
}

export function forgeClonePath(slug: string): string {
  return path.join(clonesDir(), slug);
}

export function logPath(slug: string): string {
  return path.join(forgeHome(), 'logs', `${slug}.log`);
}

/** Fixed mount point for the forge's code inside its container. */
export const CONTAINER_WORKDIR = '/workspace';

/** Stable docker volume name holding a forge's checkout + node_modules. */
export function workspaceVolumeName(slug: string): string {
  return `forge-${slug}`;
}

/** In-container home for the agent's Claude config, credentials, and transcripts. */
/** Mount point for the per-forge Claude home volume — covers the entire user
 *  home so ~/.claude/ (credentials) and ~/.claude.json (global config/userID)
 *  both persist across container restarts without any symlink tricks. */
export const CLAUDE_HOME = '/home/forge';

/**
 * Per-forge docker volume persisting the agent's Claude home so login and
 * conversation history survive container recreation.
 */
export function claudeVolumeName(slug: string): string {
  return `forge-${slug}-claude`;
}
