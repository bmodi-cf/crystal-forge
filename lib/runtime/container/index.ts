import type { ContainerManager } from './types';
import { FakeContainerManager } from './fake-container-manager';
import { DockerContainerManager } from './docker-container-manager';

let cached: ContainerManager | null = null;

export function getContainerManager(): ContainerManager {
  if (cached) return cached;
  // Read process.env live: lib/env.ts freezes its parsed values at import, so a
  // cached `env` snapshot can't reflect a mode set after this module loaded.
  cached = process.env.FORGE_RUNTIME_MODE === 'fake'
    ? new FakeContainerManager()
    : new DockerContainerManager();
  return cached;
}

export function resetContainerManager(): void { cached = null; }

export type { ContainerManager } from './types';
