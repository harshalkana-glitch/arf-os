/**
 * Object storage.
 *
 * Spec 14.6: large immutable artefacts live in object storage and PostgreSQL
 * holds their identity. Uploads are presigned so the file never passes through
 * the API process (spec 15.1), which keeps a 50 MB export off the request path
 * and out of the API's memory.
 *
 * The interface exists so the pipeline can be driven against a fake in a unit
 * test and against MinIO in an integration test, without either knowing which
 * (CLAUDE.md 7.1).
 */
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedUpload {
  readonly url: string;
  readonly objectKey: string;
  readonly expiresInSeconds: number;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ObjectStore {
  presignUpload(objectKey: string, contentType: string): Promise<PresignedUpload>;
  /** Read an object in full. Used by the parse job, never by a request path. */
  get(objectKey: string): Promise<StoredObject>;
  exists(objectKey: string): Promise<boolean>;
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** MinIO needs path-style addressing; most S3 providers do not. */
  readonly forcePathStyle: boolean;
  readonly presignTtlSeconds: number;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async presignUpload(objectKey: string, contentType: string): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
      { expiresIn: this.config.presignTtlSeconds },
    );
    return { url, objectKey, expiresInSeconds: this.config.presignTtlSeconds };
  }

  async get(objectKey: string): Promise<StoredObject> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
    );
    if (!response.Body) throw new Error(`Object ${objectKey} has no body`);
    const bytes = await response.Body.transformToByteArray();
    return {
      bytes,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }
}

/**
 * Object key for an uploaded verification report.
 *
 * Spec 14.7 scopes every path by organisation, so a signed URL for one
 * organisation can never name another's prefix even if the key were guessed.
 */
export function verificationUploadKey(
  organisationId: string,
  strategyVersionId: string,
  verificationId: string,
  uploadId: string,
  filename: string,
): string {
  // The filename is client-supplied, so it is reduced to a safe suffix rather
  // than interpolated: a "../" in it would otherwise escape the prefix.
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-64);
  return (
    `orgs/${organisationId}/strategy-versions/${strategyVersionId}/` +
    `tradingview-verification/${verificationId}/uploads/${uploadId}-${safe}`
  );
}
