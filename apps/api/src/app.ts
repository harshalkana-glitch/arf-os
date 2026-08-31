/**
 * Fastify application factory.
 *
 * Dependencies are injected rather than imported from module scope, so an
 * integration test builds an app against the test database without any
 * global state or environment mutation (CLAUDE.md 7.1).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@arf/db';
import { assertAuthSafe, resolveAuth, type AuthConfig } from './auth.js';
import { problemDetailsHandler } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerStrategyVersionRoutes } from './routes/strategy-versions.js';

export interface AppDependencies {
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly logLevel?: string;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  // Fail at construction, not per request: a deployed environment must not
  // start at all with the development auth stub enabled.
  assertAuthSafe(deps.auth);

  const app = Fastify({
    logger: { level: deps.logLevel ?? 'info' },
    // Trust the platform proxy for client IP, but never for identity.
    trustProxy: true,
    // A generated request id is the traceId echoed in every problem response.
    genReqId: () => globalThis.crypto.randomUUID(),
  });

  app.setErrorHandler(problemDetailsHandler);

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: 'https://arf-os.dev/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'route_not_found',
      detail: `No route for ${request.method} ${request.url}.`,
      instance: request.url,
      traceId: request.id,
    }),
  );

  // Health is registered before the auth hook so a probe never needs
  // credentials and never touches the database session.
  registerHealthRoutes(app, deps.db);

  app.register(async (instance) => {
    instance.addHook('preHandler', async (request) => {
      request.auth = await resolveAuth(request, deps.db, deps.auth);
    });

    registerCampaignRoutes(instance, deps.db);
    registerStrategyVersionRoutes(instance, deps.db);
  });

  return app;
}
