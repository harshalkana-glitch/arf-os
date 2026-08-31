/**
 * @arf/backtest-sdk
 *
 * Ingestion of external runner results, and the object store they are read
 * from. Shared by the API and the backtest worker: the pipeline carries no
 * HTTP types, so a worker can run it without Fastify and the API maps its
 * typed errors to problem-details responses.
 */
export {
  IngestionError,
  IngestionConflictError,
  IngestionValidationError,
  ResourceNotFoundError,
} from './errors.js';

export {
  S3ObjectStore,
  verificationUploadKey,
  type ObjectStore,
  type PresignedUpload,
  type S3Config,
  type StoredObject,
} from './storage.js';

export {
  MAX_UPLOAD_BYTES,
  completeUpload,
  createVerification,
  presignUpload,
  processVerification,
  readRunEvidence,
  type ActorContext,
  type CreateVerificationInput,
  type PresignInput,
  type ProcessResult,
} from './ingestion.js';
