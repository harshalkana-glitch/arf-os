/**
 * Typed domain errors for ingestion.
 *
 * CLAUDE.md 7.5: the domain raises typed errors and the transport maps them.
 * Defining them here rather than importing HTTP error classes is what lets a
 * worker use this pipeline without pulling in Fastify — the worker retries or
 * dead-letters on the same types the API turns into problem-details responses.
 */
export class IngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The named resource does not exist, or is not visible to this actor. */
export class ResourceNotFoundError extends IngestionError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} ${id} was not found.`, { resource, id });
  }
}

/** The request is well-formed but the state or content does not permit it. */
export class IngestionValidationError extends IngestionError {
  constructor(message: string, readonly issues: Array<{ path: string; message: string }>) {
    super('validation_failed', message, { issues });
  }
}

/** The operation conflicts with work that has already happened. */
export class IngestionConflictError extends IngestionError {}
