import { injectable, inject } from 'inversify';
import { ClientSession, Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { GLOBAL_TYPES } from '#root/types.js';
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
  constructor(@inject(GLOBAL_TYPES.Database) private readonly db: MongoDatabase) {}

  protected async col(): Promise<Collection<IleExperience>> {
    return this.db.getCollection<IleExperience>(COLLECTION);
  }

  /**
   * Read-side normaliser. Pulls every doc through this so callers can
   * treat v0 and v1 documents identically.
   *
   * IMPORTANT: builds a fresh doc rather than mutating the Mongo
   * driver's BSON object. The old code mutated the doc in place; any
   * subsequent code that held a reference (or that the driver kept in
   * a connection-pool cache) would see phantom updates that never
   * landed on the server. The shallow-clone returned here keeps the
   * `versions` array identity stable for callers but isolates the
   * call site from surprise cross-iteration writes.
   */
  private normalise(doc: IleExperience | null): IleExperience | null {
    if (!doc) return null;
    const versions = Array.isArray(doc.versions) ? doc.versions : [];
    const currentVersion =
      typeof doc.currentVersion === 'number'
        ? doc.currentVersion
        : versions.length;
    return { ...doc, versions, currentVersion };
  }

  async insert(doc: IleExperience, session?: ClientSession): Promise<IleExperience> {
    const col = await this.col();
    // Defensive: ensure the new fields exist on insert. Pin updatedAt
    // equal to createdAt so /listByOwner (which sorts by updatedAt) has
    // a defined key for fresh docs.
    if (!Array.isArray(doc.versions)) doc.versions = [];
    if (typeof doc.currentVersion !== 'number') doc.currentVersion = 0;
    const now = doc.createdAt ?? new Date();
    doc.createdAt = now;
    doc.updatedAt = now;
    const result = await col.insertOne(doc, { session });
    return { ...doc, _id: result.insertedId };
  }

  async findById(id: string, session?: ClientSession): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    return this.normalise(await col.findOne({ _id: new ObjectId(id) }, { session }));
  }

  async update(
    id: string,
    patch: Partial<IleExperience>,
    session?: ClientSession,
  ): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after', session },
    );
    return this.normalise(result ?? null);
  }

  /**
   * Atomically persist the assistant turn alongside the new HTML. Replaces
   * the previous `appendHistory(...)` + `update(...)` pair in the generation
   * pipeline, which had a window where a crash between the two writes left
   * the history containing the new turn but the doc's `html` field still
   * pointing at the previous version. The `edit()` path had the same race.
   *
   * Returns the post-write document (or null if the id is invalid).
   */
  async appendAssistantTurn(
    id: string,
    turn: { role: 'assistant'; content: string; html: string },
  ): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { html: turn.html, updatedAt: new Date() },
        $push: { history: turn },
      },
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
    session?: ClientSession,
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
    if (opts.publishedAt === null) {
      // ponytail: null means "clear" (unpublish path). The archivedAt
      // arm already has a $unset branch — mirror it for publishedAt so
      // a single setStatus call can both flip status='draft' and drop
      // the publishedAt timestamp atomically. Without this, unpublish
      // would need a separate $unset query and a follow-up race window.
      // Note: archivedAt and publishedAt clear can both fire on the
      // same call (rare, but legal) — the $unset object is replaced in
      // that case and the order is preserved by the caller.
      if (update.$unset) {
        (update.$unset as Record<string, unknown>).publishedAt = '';
      } else {
        update.$unset = { publishedAt: '' };
      }
    } else if (opts.publishedAt instanceof Date) {
      (update.$set as Record<string, unknown>).publishedAt = opts.publishedAt;
    }
    if (session) {
      await col.updateOne({ _id: new ObjectId(id) }, update, { session });
    } else {
      await col.updateOne({ _id: new ObjectId(id) }, update);
    }
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
    session?: ClientSession,
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
      { returnDocument: 'after', session },
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
      { session },
    );

    return { version: assignedVersion };
  }

  /**
   * Combined head-update + version-append for the save hot path.
   *
   * Saves 2 round-trips vs. the old (update → appendVersion → findById)
   * dance by doing $set head fields + $inc currentVersion + $push
   * snapshot in two atomic writes instead of three + a read.
   *
   * The two writes ARE still two round-trips (Mongo can't combine
   * `$inc` + `$push` with a derived `$push` value in a single op), but
   * they replace three writes + a read — net 4 RTT → 2 RTT.
   *
   * Atomicity: both writes run inside the caller's session, so a crash
   * between step 1 and step 2 rolls the whole save back. Same contract
   * as the old 3-call sequence.
   *
   * ponytail: the $push in step 2 is intentionally NOT conditional on
   * the assigned version from step 1. If step 2 fails on validation
   * (e.g. oversized html), the surrounding transaction aborts, so no
   * partial state ever reaches the client. Don't add a pre-flight
   * check here — the transaction is the only check that matters.
   */
  async saveAndAppendVersion(
    id: string,
    headPatch: Partial<IleExperience>,
    snapshot: Omit<IleVersion, 'version' | 'savedAt' | 'htmlLength'>,
    session?: ClientSession,
  ): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    const now = new Date();

    // Step 1: head $set + $inc currentVersion. Returns the doc with
    // the post-increment version number so we can stamp the snapshot.
    const bumped = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { ...headPatch, updatedAt: now },
        $inc: { currentVersion: 1 },
      },
      { returnDocument: 'after', session },
    );
    if (!bumped) return null;
    const assignedVersion =
      typeof bumped.currentVersion === 'number' ? bumped.currentVersion : 0;

    // Step 2: $push snapshot with the assigned version.
    await col.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          versions: {
            ...snapshot,
            version: assignedVersion,
            savedAt: now,
            htmlLength: snapshot.html.length,
          } as IleVersion,
        },
        $set: { updatedAt: now },
      },
      { session },
    );

    return this.normalise(bumped);
  }
  /**
   * Update an existing version's optional label without changing its content.
   */
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
   * Set the lightweight context reference on an experience. We persist
   * ONLY the provenance-shaped `IleContextRef` (source, sourceUrl,
   * title, provider, transcriptHash, createdAt) — never the raw
   * transcript. Future regenerations rebuild the context from
   * `sourceUrl`.
   */
  async setContext(
    id: string,
    context: import('../classes/transformers/IleExperience.js').IleContextRef,
  ): Promise<IleExperience | null> {
    return this.update(id, { context });
  }

  /** Clear the context reference (used when a teacher regenerates from a different source). */
  async clearContext(id: string): Promise<IleExperience | null> {
    if (!ObjectId.isValid(id)) return null;
    const col = await this.col();
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $unset: { context: '' }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return this.normalise(result ?? null);
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