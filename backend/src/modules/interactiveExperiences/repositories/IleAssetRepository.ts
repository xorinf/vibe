import { injectable, inject } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { GLOBAL_TYPES } from '#root/types.js';
import { IleAsset, IleAssetKind } from '../classes/transformers/IleAsset.js';

const COLLECTION = 'ile_assets';

@injectable()
export class IleAssetRepository {
  constructor(@inject(GLOBAL_TYPES.Database) private readonly db: MongoDatabase) {}

  private async col(): Promise<Collection<IleAsset>> {
    return this.db.getCollection<IleAsset>(COLLECTION);
  }

  async insert(doc: IleAsset): Promise<IleAsset> {
    const col = await this.col();
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async findById(id: string): Promise<IleAsset | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    return col.findOne({ _id: new ObjectId(id) });
  }

  async findByOwnerAndId(
    ownerId: string,
    id: string,
  ): Promise<IleAsset | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    return col.findOne({ _id: new ObjectId(id), ownerId });
  }

  async listByOwner(
    ownerId: string,
    opts: { kind?: IleAssetKind; query?: string; limit?: number } = {},
  ): Promise<IleAsset[]> {
    const col = await this.col();
    const filter: Record<string, unknown> = {
      ownerId,
      deletedAt: { $exists: false },
    };
    if (opts.kind) filter.kind = opts.kind;
    if (opts.query) {
      // Case-insensitive substring match on filename. Mongo's regex
      // escape prevents injection.
      const escaped = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.filename = { $regex: escaped, $options: 'i' };
    }
    const limit = Math.min(opts.limit ?? 100, 200);
    const docs = await col
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs;
  }

  async findByHashForOwner(ownerId: string, sha256: string): Promise<IleAsset | null> {
    const col = await this.col();
    return col.findOne({ ownerId, sha256, deletedAt: { $exists: false } });
  }

  async totalBytesForOwner(ownerId: string): Promise<number> {
    const col = await this.col();
    const rows = await col.find({ ownerId, deletedAt: { $exists: false } }).project({ size: 1 }).toArray();
    return rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
  }

  async patch(ownerId: string, id: string, patch: Partial<Pick<IleAsset, 'displayName' | 'tags' | 'favorite'>>): Promise<IleAsset | null> {
    if (!ObjectId.isValid(id)) return null;
    const result = await (await this.col()).findOneAndUpdate(
      { _id: new ObjectId(id), ownerId, deletedAt: { $exists: false } },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  async updateMeta(ownerId: string, id: string, meta: IleAsset['meta']): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await (await this.col()).updateOne(
      { _id: new ObjectId(id), ownerId },
      { $set: { meta, updatedAt: new Date() } },
    );
  }

  async softDelete(ownerId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const result = await (await this.col()).updateOne(
      { _id: new ObjectId(id), ownerId, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async restore(ownerId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const result = await (await this.col()).updateOne(
      { _id: new ObjectId(id), ownerId, deletedAt: { $exists: true } },
      { $unset: { deletedAt: '' }, $set: { updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async hardDelete(ownerId: string, id: string): Promise<IleAsset | null> {
    if (!ObjectId.isValid(id)) return null;
    return (await (await this.col()).findOneAndDelete({ _id: new ObjectId(id), ownerId })) ?? null;
  }

  async deleteByOwnerAndId(ownerId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const col = await this.col();
    const result = await col.deleteOne({ _id: new ObjectId(id), ownerId });
    return result.deletedCount > 0;
  }
}