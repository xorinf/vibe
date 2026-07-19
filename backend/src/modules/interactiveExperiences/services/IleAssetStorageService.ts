import { injectable } from 'inversify';
import { Storage } from '@google-cloud/storage';
import { InternalServerError } from 'routing-controllers';
import { storageConfig } from '#root/config/storage.js';

/**
 * ILE asset storage — wraps the SAME @google-cloud/storage client the
 * existing CloudStorageService uses (anomalies/ai-server modules). Lives
 * in the ILE module so the ILE module is self-contained per the
 * existing convention; the underlying transport and auth are shared.
 *
 * Object layout in the bucket:
 *   {ownerId}/{kind}/{assetId}.{ext}
 *
 * Owner-prefixed paths mean a teacher's listing query can be served
 * by the GCS list API if we ever need to — for now we go through
 * Mongo.
 */
@injectable()
export class IleAssetStorageService {
  private readonly googleStorage: Storage;
  private readonly bucketName: string;

  constructor() {
    this.googleStorage = new Storage({
      projectId: storageConfig.googleCloud.projectId,
    });
    this.bucketName = storageConfig.googleCloud.ileAssetsBucketName;
  }

  /**
   * Upload a file buffer to the ILE assets bucket. Returns the storage
   * key (the path inside the bucket) — caller persists this in Mongo
   * along with the rest of the asset metadata.
   */
  async upload(args: {
    ownerId: string;
    kind: string;
    assetId: string;
    ext: string;
    buffer: Buffer;
    contentType: string;
  }): Promise<string> {
    const key = `${args.ownerId}/${args.kind}/${args.assetId}.${args.ext}`;
    const bucket = this.googleStorage.bucket(this.bucketName);
    const file = bucket.file(key);
    try {
      await file.save(args.buffer, {
        metadata: { contentType: args.contentType },
        resumable: false, // single-shot — these are small assets
      });
      return key;
    } catch (err: any) {
      throw new InternalServerError(
        `Failed to upload asset: ${err?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Generate a short-lived signed URL the teacher (or the AI-generated
   * HTML running in their browser) can use to fetch the asset.
   *
   * 1 hour is the standard default — long enough to survive a chat
   * session without forcing us to babysit token rotation.
   */
  async getSignedUrl(storageKey: string, ttlSeconds = 60 * 60): Promise<string> {
    const bucket = this.googleStorage.bucket(this.bucketName);
    const file = bucket.file(storageKey);
    try {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + ttlSeconds * 1000,
      });
      return url;
    } catch (err: any) {
      throw new InternalServerError(
        `Failed to sign asset URL: ${err?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Hard-delete the underlying blob. Mongo row is removed separately by
   * the repository — this method only handles the GCS side.
   */
  async delete(storageKey: string): Promise<void> {
    const bucket = this.googleStorage.bucket(this.bucketName);
    try {
      await bucket.file(storageKey).delete();
    } catch (err: any) {
      // 404 is fine — the asset was already gone.
      if (err?.code === 404) return;
      throw new InternalServerError(
        `Failed to delete asset: ${err?.message ?? String(err)}`,
      );
    }
  }
}