import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadServerEnv } from '@billing/config';
import type { AppLogger } from '../common/logging/logger.js';
import { internalError } from '../common/errors/app-error.js';

/**
 * S3-compatible object storage (Tech Arch Doc §12).
 *
 * Buckets are private. Files are never served directly — access is always via
 * a short-lived signed URL issued after the API has authorised the request
 * (Security Doc §35). MinIO locally, real S3 in production; the only
 * difference is path-style addressing.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtl: number;
  readonly enabled: boolean;

  constructor(@Inject('APP_LOGGER') private readonly logger: AppLogger) {
    const env = loadServerEnv();

    this.bucket = env.S3_BUCKET ?? '';
    this.signedUrlTtl = env.S3_SIGNED_URL_TTL_SECONDS;
    this.enabled = Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID);

    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      // MinIO serves buckets as a path segment; AWS uses a host prefix.
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });

    if (!this.enabled) {
      this.logger.warn('Object storage is not configured; PDF generation will fail');
    }
  }

  /**
   * Storage key layout (Tech Arch Doc §12).
   *
   * organisationId is the first path segment so a bucket policy or lifecycle
   * rule can be scoped per tenant later, and so a stray listing cannot mix
   * tenants. The content hash is in the filename, which makes each version a
   * distinct immutable object — old ones are retained for audit rather than
   * overwritten.
   */
  buildKey(params: {
    organisationId: string;
    entityType: 'invoices' | 'quotations';
    entityId: string;
    contentHash: string;
  }): string {
    return `organisations/${params.organisationId}/${params.entityType}/${params.entityId}/${params.entityType.slice(0, -1)}-${params.contentHash.slice(0, 16)}.pdf`;
  }

  async put(key: string, body: Buffer, contentType = 'application/pdf'): Promise<void> {
    if (!this.enabled) {
      throw internalError('Object storage is not configured');
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Defence in depth behind the private bucket policy.
        ACL: undefined,
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Issue a short-lived download URL.
   *
   * Callers MUST have already checked that the requester may see this
   * document: the URL grants access to anyone holding it for its lifetime.
   */
  async signedDownloadUrl(key: string, filename?: string): Promise<string> {
    if (!this.enabled) {
      throw internalError('Object storage is not configured');
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Makes the browser save the file under a human-readable name rather
        // than the hashed storage key.
        ...(filename
          ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
          : {}),
      }),
      { expiresIn: this.signedUrlTtl },
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
