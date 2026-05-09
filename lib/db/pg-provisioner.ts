import { Client } from 'pg';
import type { DatabaseProvisioner } from './types';

const SAFE_DBNAME = /^[a-z0-9_]+$/;

export class PgDatabaseProvisioner implements DatabaseProvisioner {
  private readonly adminUrl: string;

  constructor(config: {
    host: string;
    port: number;
    user: string;
    password: string;
  }) {
    const url = new URL('postgres://placeholder/postgres');
    url.username = encodeURIComponent(config.user);
    url.password = encodeURIComponent(config.password);
    url.hostname = config.host;
    url.port = String(config.port);
    this.adminUrl = url.toString();
  }

  async createDatabase(name: string): Promise<void> {
    this.assertSafe(name);
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } finally {
      await client.end();
    }
  }

  async dropDatabase(name: string): Promise<void> {
    this.assertSafe(name);
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await client.end();
    }
  }

  private assertSafe(name: string): void {
    if (!SAFE_DBNAME.test(name)) {
      throw new Error(`Refusing to use unsafe database name: ${JSON.stringify(name)}`);
    }
  }
}
