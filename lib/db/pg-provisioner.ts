import { Client } from 'pg';
import type { DatabaseProvisioner } from './types';
import { assertSafeIdentifier, buildAdminUrl } from './identifiers';

export class PgDatabaseProvisioner implements DatabaseProvisioner {
  private readonly config: { host: string; port: number; user: string; password: string };
  private readonly adminUrl: string;

  constructor(config: {
    host: string;
    port: number;
    user: string;
    password: string;
  }) {
    this.config = config;
    this.adminUrl = buildAdminUrl(config, 'postgres');
  }

  async createDatabase(name: string): Promise<void> {
    assertSafeIdentifier(name, 'database');
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } finally {
      await client.end();
    }
  }

  async dropDatabase(name: string): Promise<void> {
    assertSafeIdentifier(name, 'database');
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await client.end();
    }
  }

  private dbUrl(database: string): string {
    return buildAdminUrl(this.config, database);
  }

  async provisionRole(database: string, role: string): Promise<void> {
    assertSafeIdentifier(database, 'database');
    assertSafeIdentifier(role, 'role');
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
    assertSafeIdentifier(role, 'role');
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
    assertSafeIdentifier(role, 'role');
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  }

  async hardenDatabase(name: string): Promise<void> {
    assertSafeIdentifier(name, 'database');
    const admin = new Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
    } finally { await admin.end(); }
  }
}
