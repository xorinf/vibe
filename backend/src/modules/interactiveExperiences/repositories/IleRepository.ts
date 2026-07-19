import { injectable } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { IleExperience, IleStatus, IleVersion } from '../classes/transformers/IleExperience.js';

const COLLECTION = 'interactive_experiences';

/**
 * Thin repository over the interactive_experiences collection.
 * Lives in this module — the only place that knows the Mongo shape.
 *
 * Backwards compatibility: documents created before versioning shipped
 * have no `versions[]`, `currentVersion`, `publishedAt`, `archivedAt`,
 * or `authorName` fields. Read paths normalise those to safe defaults so
 * old docs behave identically to new ones — no migration script required.
 */
@injectable()
export class IleRepository {
  constructor(private readonly db: MongoDatabase) {}

  private async col(): Promise<Collection<IleExperience>> {
    return this.db.getCollection<IleExperience>(COLLECTION);
  }

  /**
   * Read-side normaliser. Pulls every doc through this so callers can
   * treat v0 and v1 documents identically.
   */
  private normalise(doc: IleExperience | null): IleExperience | null {
    if (!doc) return null;
    if (!Array.isArray(doc.versions)) doc.versions = [];
    if (typeof doc.currentVersion !== 'number') doc.currentVersion = doc.versions.length;
    return doc;
  }

  async insert(doc: IleExperience): Promise<IleExperience> {
    const col = await this.col();
    // Defensive: ensure the new fields exist on insert. Pin updatedAt
    // equal to createdAt so /listByOwner (which sorts by updatedAt) has
    // a defined key for fresh docs.
    if (!Array.isArray(doc.versions)) doc.versions = [];
    if (typeof doc.currentVersion !== 'number') doc.currentVersion = 0;
    const now = doc.createdAt ?? new Date();
    doc.createdAt = now;
    doc.updatedAt = now;
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async findById(id: string): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    return this.normalise(await col.findOne({ _id: new ObjectId(id) }));
  }

  async update(id: string, patch: Partial<IleExperience>): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return this.normalise(result ?? null);
  }

  async appendHistory(
    id: string,
    turn: { role: 'user' | 'assistant'; content: string; html?: string },
  ): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    const col = await this.col();
    await col.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: { history: turn },
        $set: { updatedAt: new Date() },
      },
    );
  }

  async setStatus(
    id: string,
    status: IleStatus,
    opts: { archivedAt?: Date | null; publishedAt?: Date | null } = {},
  ): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    const col = await this.col();
    const now = new Date();

    // Build the update document in one pass. archivedAt=null means
    // "clear the field" -> translate to $unset so the unarchive path
    // is atomic with the status flip. No intermediate state where the
    // status is updated but archivedAt is stale.
    const update: Record<string, unknown> = {
      $set: { status, updatedAt: now },
    };
    if (opts.archivedAt === null) {
      update.$unset = { archivedAt: '' };
    } else if (opts.archivedAt instanceof Date) {
      (update.$set as Record<string, unknown>).archivedAt = opts.archivedAt;
    }
    if (opts.publishedAt instanceof Date) {
      (update.$set as Record<string, unknown>).publishedAt = opts.publishedAt;
    }
    await col.updateOne({ _id: new ObjectId(id) }, update);
  }

  /**
   * Append a new version snapshot.
   *
   * Two-step but race-safe:
   *   1. Atomic $inc on `currentVersion` via findOneAndUpdate — the returned
   *      document tells us the post-increment value (the assigned version
   *      number for THIS write).
   *   2. $push the new snapshot using that exact number.
   *
   * Two concurrent saves interleave at most like (1a → 2a → 1b → 2b). Both
   * get unique, monotonic version numbers. Snapshot ordering in the
   * versions[] array may not match the increment order under concurrency,
   * but every entry's `version` field is unique and correct.
   */
  async appendVersion(
    id: string,
    snapshot: Omit<IleVersion, 'version' | 'savedAt' | 'htmlLength'>,
  ): Promise<{ version: number }> {
    if (!ObjectId.isValid(id)) return { version: 0 };
    const col = await this.col();
    const now = new Date();
    const htmlLength = snapshot.html.length;

    // Step 1 — atomic counter bump + updatedAt stamp. We only need the
    // post-update `currentVersion` value, so we discard the rest of the
    // returned doc.
    const bumped = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { currentVersion: 1 }, $set: { updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!bumped) return { version: 0 };
    const assignedVersion =
      typeof bumped.currentVersion === 'number' ? bumped.currentVersion : 0;

    // Step 2 — append the snapshot with the assigned version number.
    // The snapshot append is a second round-trip but the version number
    // it pushes is uniquely determined by step 1.
    await col.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          versions: {
            ...snapshot,
            version: assignedVersion,
            savedAt: now,
            htmlLength,
          } as IleVersion,
        },
        $set: { updatedAt: now },
      },
    );

    return { version: assignedVersion };
  }

  /** Update an existing version's optional label without changing its content. */
  async labelVersion(
    id: string,
    version: number,
    label: string | null,
  ): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    const col = await this.col();
    // Mongo's positional operator targets the first array element matching
    // the predicate in the update document.
    await col.updateOne(
      { _id: new ObjectId(id), 'versions.version': version },
      {
        $set: {
          'versions.$.label': label ?? undefined,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * List experiences owned by a user, optionally filtering by status.
   * Excludes archived by default — pass `{ includeArchived: true }` to
   * surface them (e.g. for an archive-tab UI later).
   */
  async listByOwner(
    ownerId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<IleExperience[]> {
    const col = await this.col();
    const filter: Record<string, unknown> = { ownerId };
    if (!opts.includeArchived) {
      filter.status = { $ne: 'archived' };
    }
    const docs = await col.find(filter).sort({ updatedAt: -1 }).toArray();
    return docs.map((d) => this.normalise(d)).filter((d): d is IleExperience => Boolean(d));
  }
}