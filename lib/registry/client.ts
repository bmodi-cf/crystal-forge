import type { RegistryClient } from './types';
import { FakeRegistryClient } from './fake-client';
import { HttpRegistryClient } from './http-client';

let cached: RegistryClient | undefined;

export function getRegistryClient(): RegistryClient {
  if (cached) return cached;
  if (process.env.REGISTRY_CLIENT_MODE === 'fake') {
    cached = new FakeRegistryClient();
  } else {
    const host = process.env.REGISTRY_HOST;
    const username = process.env.REGISTRY_USERNAME;
    const password = process.env.REGISTRY_PASSWORD;
    if (!host || !username || !password) {
      throw new Error(
        'REGISTRY_HOST, REGISTRY_USERNAME, REGISTRY_PASSWORD must be set (or REGISTRY_CLIENT_MODE=fake)',
      );
    }
    cached = new HttpRegistryClient({ host, username, password });
  }
  return cached;
}

/** Test-only: reset the memoized client. */
export function __resetRegistryClientForTests(): void {
  cached = undefined;
}
