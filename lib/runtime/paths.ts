import os from 'node:os';
import path from 'node:path';

export function forgeHome(): string {
  // Read live from process.env so tests can override CRYSTAL_FORGE_HOME per-run.
  return process.env.CRYSTAL_FORGE_HOME ?? path.join(os.homedir(), '.crystal-forge');
}

export function stateFilePath(): string {
  return path.join(forgeHome(), 'state.json');
}

export function deploymentsFilePath(): string {
  return path.join(forgeHome(), 'deployments.json');
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

/**
 * Mount point and volume for pnpm's content-addressable package store.
 *
 * Shared by every forge rather than per-forge: the store is addressed by
 * content, so one warm copy serves all of them and a brand-new forge starts
 * warm. Without a volume the store lives in the container's writable layer,
 * and since a forge container is recreated (never restarted), every start
 * re-downloads every package from cold. Grows without bound — needs an
 * occasional `pnpm store prune`.
 */
export const PNPM_STORE_DIR = '/pnpm-store';
export const PNPM_STORE_VOLUME = 'forge-pnpm-store';

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
