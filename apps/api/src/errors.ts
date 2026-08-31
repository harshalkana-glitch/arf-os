/**
 * Typed domain errors and RFC 9457 problem-details responses.
 *
 * CLAUDE.md 7.5: errors are typed, and a response never exposes secrets,
 * model prompts, SQL, stack traces or provider credentials. The mapper below
 * is the only place an error becomes a response body, so there is exactly one
 * place to audit for leakage.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  IngestionConflictError,
  IngestionError,
  IngestionValidationError,
  ResourceNotFoundError,
} from '@arf/backtest-sdk';

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  traceId?: string;
  validationErrors?: Array<{ path: string; message: string }>;
  /** Additional machine-readable context, e.g. which evidence is missing. */
  context?: Record<string, unknown>;
};

/**
 * Base class for errors that are safe to describe to a client.
 *
 * Anything not extending this is treated as an internal failure and reported
 * as a bare 500, because an unexpected error's message may contain a
 * connection string, a query, or provider output.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly title: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    // The id is echoed but the existence of another organisation's resource
    // is never confirmed: an unauthorised read and a genuine miss both land
    // here, so the two are indistinguishable to a caller.
    super('not_found', 404, 'Not Found', `${resource} ${id} was not found.`);
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super('validation_failed', 422, 'Unprocessable Entity', message);
  }
}

export class UnauthorisedError extends DomainError {
  constructor(message = 'Authentication is required.') {
    super('unauthorised', 401, 'Unauthorized', message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('forbidden', 403, 'Forbidden', message, context);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(code, 409, 'Conflict', message, context);
  }
}

/**
 * A transition the workflow policy refused.
 *
 * 422 rather than 403: the caller may well be permitted to act, but the
 * evidence or state does not support the transition. The workflow's structured
 * detail travels in `context` so a UI can list what is missing instead of
 * rendering a bare refusal (CLAUDE.md 18.3).
 */
export class PolicyRejectionError extends DomainError {
  constructor(code: string, message: string, context: Record<string, unknown>) {
    super(`policy_${code.toLowerCase()}`, 422, 'Policy Rejection', message, context);
  }
}

/** An Idempotency-Key reused with a different request body (CLAUDE.md 17.5). */
export class IdempotencyConflictError extends ConflictError {
  constructor() {
    super(
      'idempotency_key_reuse',
      'This Idempotency-Key was already used with a different request body.',
    );
  }
}

function zodToProblem(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * Convert any thrown value into a problem-details response.
 *
 * Registered once as the Fastify error handler. Unknown errors are logged in
 * full server-side and reduced to an opaque 500 for the client.
 */
export function problemDetailsHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const traceId = request.id;
  const instance = request.url;

  if (error instanceof ZodError) {
    const body: ProblemBody = {
      type: 'https://arf-os.dev/problems/validation-failed',
      title: 'Unprocessable Entity',
      status: 422,
      code: 'validation_failed',
      detail: 'The request body did not match the expected schema.',
      instance,
      traceId,
      validationErrors: zodToProblem(error),
    };
    return reply.status(422).type('application/problem+json').send(body);
  }

  if (error instanceof ValidationError) {
    const body: ProblemBody = {
      type: `https://arf-os.dev/problems/${error.code}`,
      title: error.title,
      status: error.status,
      code: error.code,
      detail: error.message,
      instance,
      traceId,
      validationErrors: error.issues,
    };
    return reply.status(error.status).type('application/problem+json').send(body);
  }

  /**
   * Domain errors from @arf/backtest-sdk carry no HTTP knowledge, which is
   * what lets the worker use the same pipeline. Mapping them to a status
   * happens here and only here.
   */
  if (error instanceof IngestionError) {
    const status =
      error instanceof ResourceNotFoundError
        ? 404
        : error instanceof IngestionConflictError
          ? 409
          : 422;
    const body: ProblemBody = {
      type: `https://arf-os.dev/problems/${error.code}`,
      title: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Unprocessable Entity',
      status,
      code: error.code,
      detail: error.message,
      instance,
      traceId,
      ...(error instanceof IngestionValidationError
        ? { validationErrors: error.issues }
        : {}),
    };
    return reply.status(status).type('application/problem+json').send(body);
  }

  if (error instanceof DomainError) {
    const body: ProblemBody = {
      type: `https://arf-os.dev/problems/${error.code}`,
      title: error.title,
      status: error.status,
      code: error.code,
      detail: error.message,
      instance,
      traceId,
      ...(error.context ? { context: error.context } : {}),
    };
    return reply.status(error.status).type('application/problem+json').send(body);
  }

  // Unknown failure. The full error goes to the log; the client gets nothing
  // beyond a trace id it can quote to an operator.
  request.log.error({ err: error, traceId }, 'unhandled error');
  const body: ProblemBody = {
    type: 'https://arf-os.dev/problems/internal-error',
    title: 'Internal Server Error',
    status: 500,
    code: 'internal_error',
    detail: 'An unexpected error occurred.',
    instance,
    traceId,
  };
  return reply.status(500).type('application/problem+json').send(body);
}
