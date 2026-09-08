import type { ContainerManager } from './types';
import { FakeContainerManager } from './fake-container-manager';
import { DockerContainerManager } from './docker-container-manager';

// Held on globalThis, like lib/prisma.ts: under `next dev` a module can be
// instantiated more than once (instrumentation.ts and a route handler each get
// their own registry), and a per-module cache would hand them *different*
// managers. That is harmless for the docker manager, which is a thin shell over
// an external daemon, but fatal for the fake one, whose containers live in its
// own memory: the liveness loop would inspect an empty registry, see every
// forge as gone, and flip a healthy `running` entry to `crashed`.
const globalForContainers = globalThis as unknown as {
  containerManager: ContainerManager | undefined;
};

export function getContainerManager(): ContainerManager {
  if (globalForContainers.containerManager) return globalForContainers.containerManager;
  // Read process.env live: lib/env.ts freezes its parsed values at import, so a
  // cached `env` snapshot can't reflect a mode set after this module loaded.
  globalForContainers.containerManager = process.env.FORGE_RUNTIME_MODE === 'fake'
    ? new FakeContainerManager()
    : new DockerContainerManager();
  return globalForContainers.containerManager;
}

export function resetContainerManager(): void {
  globalForContainers.containerManager = undefined;
}

export type { ContainerManager } from './types';
