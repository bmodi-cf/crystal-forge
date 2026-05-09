import type { DatabaseProvisioner } from './types';

type Method = 'createDatabase' | 'dropDatabase';

export class FakeDatabaseProvisioner implements DatabaseProvisioner {
  private readonly databases = new Set<string>();
  private readonly nextErrors = new Map<Method, Error>();

  async createDatabase(name: string): Promise<void> {
    this.maybeFail('createDatabase');
    if (this.databases.has(name)) {
      throw new Error(`database "${name}" already exists`);
    }
    this.databases.add(name);
  }

  async dropDatabase(name: string): Promise<void> {
    this.maybeFail('dropDatabase');
    this.databases.delete(name);
  }

  // Test helpers -----------------------------------------------------------

  has(name: string): boolean {
    return this.databases.has(name);
  }

  list(): string[] {
    return [...this.databases];
  }

  failNextCall(method: Method, error: Error): void {
    this.nextErrors.set(method, error);
  }

  private maybeFail(method: Method): void {
    const err = this.nextErrors.get(method);
    if (err) {
      this.nextErrors.delete(method);
      throw err;
    }
  }
}
