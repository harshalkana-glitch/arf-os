import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated into packages/db/migrations and applied by
 * src/migrate.ts as a dedicated release step (spec 20.3). Generated SQL is
 * reviewed before it is committed; drizzle-kit push is deliberately not used,
 * because CLAUDE.md 9.2 requires every schema change to go through a
 * migration that can be replayed.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5432/arf',
  },
  strict: true,
  verbose: true,
});
