/**
 * Fastify application factory.
 *
 * Dependencies are injected rather than imported from module scope, so an
 * integration test builds an app against the test database without any
 * global state or environment mutation (CLAUDE.md 7.1).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Database } from '@arf/db';
import { assertAuthSafe, resolveAuth, type AuthConfig } from './auth.js';
import { problemDetailsHandler } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerStrategyVersionRoutes } from './routes/strategy-versions.js';
import { registerVerificationRoutes } from './routes/verifications.js';
import type { ObjectStore } from '@arf/backtest-sdk';

export interface AppDependencies {
  readonly db: Database;
  readonly auth: AuthConfig;
  /** Object store for presigned uploads and artefact reads. */
  readonly store: ObjectStore;
  /**
   * Browser origins permitted to call this API.
   *
   * Required rather than defaulted: the web app runs on a different port to
   * the API, so every write from it is cross-origin and is blocked outright
   * without this. An empty list disables browser access entirely, which is
   * the correct posture for a service with no browser client.
   */
  readonly allowedOrigins: readonly string[];
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

  /**
   * CORS, restricted to an explicit allowlist — never a wildcard.
   *
   * Requests carry organisation-scoped identity, so reflecting an arbitrary
   * Origin would let any page a researcher visits read their research
   * (CLAUDE.md 19).
   */
  void app.register(cors, {
    origin: (origin, callback) => {
      // A same-origin or non-browser request sends no Origin header.
      if (!origin) return callback(null, true);
      callback(null, deps.allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-dev-user', 'x-organisation-id'],
    credentials: true,
    maxAge: 600,
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
    registerVerificationRoutes(instance, deps.db, deps.store);
  });

  return app;
}
