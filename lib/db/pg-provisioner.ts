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

  private dbUrl(database: string): string {
    const url = new URL(this.adminUrl);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async provisionRole(database: string, role: string): Promise<void> {
    this.assertSafe(database);
    this.assertSafe(role);
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE "${role}" LOGIN;
           END IF;
         END $$;`,
      );
      await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    } finally { await admin.end(); }

    const target = new Client({ connectionString: this.dbUrl(database) });
    await target.connect();
    try {
      await target.query(`GRANT ALL ON SCHEMA public TO "${role}"`);
    } finally { await target.end(); }
  }

  async setRolePassword(role: string, password: string): Promise<void> {
    this.assertSafe(role);
    if (!/^[a-f0-9]+$/.test(password)) {
      throw new Error('Refusing to set a password outside the safe hex charset');
    }
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`ALTER ROLE "${role}" WITH PASSWORD '${password}'`);
    } finally { await admin.end(); }
  }

  async dropRole(role: string): Promise<void> {
    this.assertSafe(role);
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  }

  private assertSafe(name: string): void {
    if (!SAFE_DBNAME.test(name)) {
      throw new Error(`Refusing to use unsafe database name: ${JSON.stringify(name)}`);
    }
  }
}
