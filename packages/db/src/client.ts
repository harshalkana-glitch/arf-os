/**
 * Database client and ID generation.
 *
 * The pool is created by an explicit factory rather than at module load, so
 * tests can point at the test database and workers can size their own pools
 * (CLAUDE.md 7.1: dependency injection at service boundaries). Nothing here
 * reads `process.env` implicitly at import time.
 */
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { v7 as uuidv7 } from 'uuid';
import * as schema from './schema/index';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Generate a UUIDv7.
 *
 * PostgreSQL 17 has no `uuidv7()` built in, so IDs are minted here. v7 is
 * time-ordered, which keeps primary-key inserts append-mostly and lets
 * "newest first" listings use the primary key rather than a secondary index
 * on created_at (CLAUDE.md 7.2).
 */
export function newId(): string {
  return uuidv7();
}

export interface DatabaseConfig {
  readonly url: string;
  /** Maximum pooled connections. Workers use fewer than the API. */
  readonly maxConnections?: number;
  /** Fail fast rather than hang when the database is unreachable. */
  readonly connectionTimeoutMillis?: number;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Numeric columns come back as strings, which is what we want: `numeric` is
 * exact and `Number` is not, so the value goes to decimal.js untouched
 * (CLAUDE.md 7.4). node-postgres does this by default for numeric, but the
 * parser is set explicitly so a dependency default can never silently change
 * it to a float.
 */
function configureTypeParsers(): void {
  const NUMERIC_OID = 1700;
  const INT8_OID = 20;
  pg.types.setTypeParser(NUMERIC_OID, (v) => v);
  // bigint likewise stays a string rather than lossily becoming a JS number.
  pg.types.setTypeParser(INT8_OID, (v) => v);
}

export function createDatabase(config: DatabaseConfig): DatabaseHandle {
  configureTypeParsers();

  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    // Every session speaks UTC. Timestamps are stored with time zone and read
    // as strings, but this removes any doubt about how the server renders
    // them (CLAUDE.md 7.3).
    options: '-c timezone=UTC',
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}

export { schema };
