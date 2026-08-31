/**
 * Liveness and readiness.
 *
 * Registered outside the authenticated scope so a platform probe never needs
 * credentials. Readiness actually touches the database, because a process
 * that cannot reach PostgreSQL is not ready to serve even though it responds.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@arf/db';

export function registerHealthRoutes(app: FastifyInstance, db: Database): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', database: 'reachable' };
    } catch {
      // The underlying error may carry a connection string, so it is logged
      // by the error handler path only, never returned.
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });
}
