import { injectable } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { IleAsset, IleAssetKind } from '../classes/transformers/IleAsset.js';

const COLLECTION = 'ile_assets';

@injectable()
export class IleAssetRepository {
  constructor(private readonly db: MongoDatabase) {}

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
    const filter: Record<string, unknown> = { ownerId };
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

  async deleteByOwnerAndId(ownerId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const col = await this.col();
    const result = await col.deleteOne({ _id: new ObjectId(id), ownerId });
    return result.deletedCount > 0;
  }
}