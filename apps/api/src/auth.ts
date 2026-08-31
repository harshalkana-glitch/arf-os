/**
 * Authentication and organisation scoping.
 *
 * CLAUDE.md 19: organisation ownership is verified on every aggregate access,
 * and a client-supplied organisation id is never trusted. The membership row
 * is the only source of both the organisation and the role, so a caller
 * cannot elevate itself by asserting a role in a header or body.
 */
import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@arf/db';
import { memberships, users } from '@arf/db/schema';
import type { RbacRole } from '@arf/contracts';
import { ForbiddenError, NotFoundError, UnauthorisedError } from './errors.js';

export interface AuthContext {
  readonly userId: string;
  readonly externalId: string;
  readonly organisationId: string;
  readonly role: RbacRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthConfig {
  /**
   * When true, a request may authenticate with `x-dev-user` instead of a
   * real token. Guarded by environment, not by a flag alone: a deployed
   * environment refuses to start with this enabled (see `assertAuthSafe`).
   */
  readonly allowDevAuth: boolean;
  readonly environment: string;
}

/**
 * Refuse to start with the development auth stub enabled outside `local`.
 *
 * Called at boot rather than per request, so a misconfiguration is a startup
 * failure rather than a silent authentication bypass in production.
 */
export function assertAuthSafe(config: AuthConfig): void {
  if (config.allowDevAuth && config.environment !== 'local') {
    throw new Error(
      `Development auth stub is enabled but ARF_ENVIRONMENT is "${config.environment}". ` +
        'Refusing to start: this would accept an unauthenticated header as identity.',
    );
  }
}

/**
 * Resolve the caller's identity and organisation membership.
 *
 * The membership lookup is the authorisation step: a user with no active
 * membership in the organisation is indistinguishable from a user who does
 * not exist, so probing cannot enumerate organisations.
 */
export async function resolveAuth(
  request: FastifyRequest,
  db: Database,
  config: AuthConfig,
): Promise<AuthContext> {
  const externalId = extractSubject(request, config);

  const rows = await db
    .select({
      userId: users.id,
      externalId: users.externalId,
      organisationId: memberships.organisationId,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(users.externalId, externalId), isNull(memberships.revokedAt)))
    .limit(2);

  const first = rows[0];
  if (!first) {
    throw new UnauthorisedError('No active organisation membership for this identity.');
  }

  // A user belonging to several organisations must say which one they are
  // acting in; picking the first would silently scope their work to an
  // arbitrary org.
  if (rows.length > 1) {
    const requested = request.headers['x-organisation-id'];
    const match = rows.find((r) => r.organisationId === requested);
    if (!match) {
      throw new ForbiddenError(
        'This identity belongs to multiple organisations; specify x-organisation-id.',
      );
    }
    return match;
  }

  return first;
}

function extractSubject(request: FastifyRequest, config: AuthConfig): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ') === true) {
    // Clerk session verification lands here. Until it does, a bearer token is
    // rejected outright rather than being parsed optimistically: accepting an
    // unverified token would be worse than accepting none.
    throw new UnauthorisedError('Bearer token verification is not yet configured.');
  }

  if (config.allowDevAuth) {
    const devUser = request.headers['x-dev-user'];
    if (typeof devUser === 'string' && devUser.length > 0) {
      return devUser;
    }
  }

  throw new UnauthorisedError();
}

/** Require that the caller holds one of `roles`. */
export function requireRole(auth: AuthContext, roles: readonly RbacRole[]): void {
  if (!roles.includes(auth.role)) {
    throw new ForbiddenError(`Role ${auth.role} may not perform this action.`, {
      requiredRoles: roles,
    });
  }
}

/**
 * Assert that a loaded row belongs to the caller's organisation.
 *
 * Reads are already filtered by organisation; this is the second line of
 * defence for any path that loads by primary key, where forgetting the filter
 * would otherwise expose another organisation's research.
 */
export function assertSameOrganisation<T extends { organisationId: string }>(
  auth: AuthContext,
  row: T | undefined,
  resource: string,
  id: string,
): asserts row is T {
  if (!row || row.organisationId !== auth.organisationId) {
    // Deliberately a 404, not a 403: a 403 would confirm that this id exists
    // in another organisation, which is itself a disclosure.
    throw new NotFoundError(resource, id);
  }
}
