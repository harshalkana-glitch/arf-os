/**
 * @arf/db
 *
 * PostgreSQL is the system of record for identity, workflow state, the
 * strategy registry, decisions and audit (CLAUDE.md 9.1). Large immutable
 * artefacts live in object storage and are referenced from here by key and
 * checksum.
 */
export { createDatabase, newId, schema, type Database, type DatabaseConfig, type DatabaseHandle } from './client';
export * as tables from './schema/index';
