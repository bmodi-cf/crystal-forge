import { describe, it, expect, afterEach } from 'vitest';
import { getContainerManager, resetContainerManager } from './index';
import { FakeContainerManager } from './fake-container-manager';
import { DockerContainerManager } from './docker-container-manager';

afterEach(() => { resetContainerManager(); delete process.env.FORGE_RUNTIME_MODE; });

describe('getContainerManager', () => {
  it('returns the fake when FORGE_RUNTIME_MODE=fake', () => {
    process.env.FORGE_RUNTIME_MODE = 'fake';
    expect(getContainerManager()).toBeInstanceOf(FakeContainerManager);
  });
  it('returns the docker manager when FORGE_RUNTIME_MODE=docker', () => {
    process.env.FORGE_RUNTIME_MODE = 'docker';
    expect(getContainerManager()).toBeInstanceOf(DockerContainerManager);
  });
});
