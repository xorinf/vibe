import { injectable } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { IleAiConfig } from '../services/providers/types.js';

const COLLECTION = 'ile_ai_configs';

/**
 * Per-owner ILE AI configuration. One document per teacher.
 *
 * NOTE: The apiKey is stored as plaintext. This is acceptable for local-dev
 * single-tenant deployments, but MUST be replaced with at-rest encryption
 * (KMS / envelope encryption) before any production rollout. Flagged here so
 * the next person who picks this up doesn't ship it to prod.
 */
@injectable()
export class IleAiConfigRepository {
  constructor(private readonly db: MongoDatabase) {}

  private async col(): Promise<Collection<IleAiConfig & { _id: ObjectId; ownerId: string }>> {
    return this.db.getCollection(COLLECTION) as any;
  }

  async findByOwner(ownerId: string): Promise<IleAiConfig | null> {
    const col = await this.col();
    const doc = await col.findOne({ ownerId });
    if (!doc) return null;
    // Strip _id from the typed payload
    const { _id, ...rest } = doc as any;
    return rest as IleAiConfig;
  }

  async upsert(ownerId: string, patch: IleAiConfig): Promise<IleAiConfig> {
    const col = await this.col();
    const now = new Date();
    await col.updateOne(
      { ownerId },
      {
        $set: { ...patch, ownerId, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    const found = await this.findByOwner(ownerId);
    if (!found) {
      // Should be unreachable — upsert succeeded.
      throw new Error('Failed to read back upserted ILE AI config');
    }
    return found;
  }

  async delete(ownerId: string): Promise<void> {
    const col = await this.col();
    await col.deleteOne({ ownerId });
  }
}