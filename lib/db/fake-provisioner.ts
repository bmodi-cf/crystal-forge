import type { DatabaseProvisioner } from './types';

type Method =
  | 'createDatabase'
  | 'dropDatabase'
  | 'provisionRole'
  | 'setRolePassword'
  | 'dropRole'
  | 'hardenDatabase';

export class FakeDatabaseProvisioner implements DatabaseProvisioner {
  private readonly databases = new Set<string>();
  private readonly roles = new Map<string, string>();
  private readonly hardened = new Set<string>();
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

  async provisionRole(_database: string, role: string): Promise<void> {
    this.maybeFail('provisionRole');
    if (!this.roles.has(role)) this.roles.set(role, '');
  }

  async setRolePassword(role: string, password: string): Promise<void> {
    this.maybeFail('setRolePassword');
    this.roles.set(role, password);
  }

  async dropRole(role: string): Promise<void> {
    this.maybeFail('dropRole');
    this.roles.delete(role);
  }

  async hardenDatabase(name: string): Promise<void> {
    this.maybeFail('hardenDatabase');
    this.hardened.add(name);
  }

  // Test helpers -----------------------------------------------------------

  has(name: string): boolean {
    return this.databases.has(name);
  }

  hasRole(role: string): boolean { return this.roles.has(role); }
  passwordOf(role: string): string | undefined { return this.roles.get(role); }
  isHardened(name: string): boolean { return this.hardened.has(name); }

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
