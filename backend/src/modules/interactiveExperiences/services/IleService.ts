import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { IleRepository } from '../repositories/IleRepository.js';
import {
  IleExperience,
  IleVersion,
} from '../classes/transformers/IleExperience.js';

export interface SaveArgs {
  ownerId: string;
  authorName?: string;
  _id?: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  title: string;
  prompt: string;
  html: string;
  label?: string;
}

export interface RenameArgs {
  ownerId: string;
  title: string;
}

/**
 * Save / fetch / publish / version orchestration.
 *
 * Every save appends a snapshot to `versions[]` AND updates the head
 * fields. The frontend's existing read endpoints (`/:id`, `/play`) keep
 * working because the head fields still reflect the latest version.
 */
@injectable()
export class IleService {
  constructor(
    @inject(ILE_TYPES.IleRepository) private readonly repo: IleRepository,
  ) {}

  /**
   * Save is now always versioned. First save seeds version 1; subsequent
   * saves append a new snapshot and bump `currentVersion`. The head
   * fields (`html`, `title`, `prompt`) stay in sync with the latest.
   */
  async save(args: SaveArgs): Promise<IleExperience> {
    const savedBy = args.authorName || args.ownerId;

    if (!args._id) {
      // Fresh insert — seed version 1 in the versions array so the
      // first save shows up in history immediately.
      const firstSnapshot: IleVersion = {
        version: 1,
        savedAt: new Date(),
        savedBy,
        title: args.title,
        html: args.html,
        prompt: args.prompt,
        label: args.label,
        htmlLength: args.html.length,
      };
      const fresh = new IleExperience({
        ownerId: args.ownerId,
        authorName: savedBy,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        itemId: args.itemId,
        title: args.title,
        prompt: args.prompt,
        history: [
          { role: 'user', content: args.prompt },
          { role: 'assistant', content: 'Manually saved', html: args.html },
        ],
        html: args.html,
        status: 'draft',
        versions: [firstSnapshot],
        currentVersion: 1,
      });
      return this.repo.insert(fresh);
    }

    // Existing doc — append a new version, then update head fields.
    const updated = await this.repo.update(args._id, {
      title: args.title,
      html: args.html,
      prompt: args.prompt,
      itemId: args.itemId,
      courseId: args.courseId,
      courseVersionId: args.courseVersionId,
      authorName: savedBy,
    });
    if (!updated) {
      throw new Error('Experience not found');
    }
    await this.repo.appendVersion(args._id, {
      savedBy,
      title: args.title,
      html: args.html,
      prompt: args.prompt,
      label: args.label,
    });
    // Re-read so the returned doc has the new currentVersion + appended
    // version in its versions[] array.
    const refreshed = await this.repo.findById(args._id);
    if (!refreshed) throw new Error('Experience not found after save');
    return refreshed;
  }

  async get(id: string): Promise<IleExperience | null> {
    return this.repo.findById(id);
  }

  async getOwned(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.repo.findById(id);
    if (!doc) return null;
    if (doc.ownerId !== ownerId) return null;
    return doc;
  }

  /**
   * For student playback we only return published (and non-archived)
   * experiences, and we intentionally omit the chat history.
   */
  async getPublishedForStudent(
    id: string,
  ): Promise<Pick<IleExperience, '_id' | 'title' | 'html'> | null> {
    const doc = await this.repo.findById(id);
    if (!doc) return null;
    // Archived → not playable, even if it was published before.
    if (doc.status === 'archived') return null;
    if (doc.status !== 'published') return null;
    return { _id: doc._id, title: doc.title, html: doc.html };
  }

  /**
   * Publish. Idempotent — re-publishing just refreshes `publishedAt`.
   * Archived experiences cannot be re-published; unarchive first.
   */
  async publish(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.repo.findById(id);
    if (!doc) return null;
    if (doc.ownerId !== ownerId) return null;
    if (doc.status === 'archived') return null;
    const now = new Date();
    await this.repo.setStatus(id, 'published', { publishedAt: now });
    return this.repo.findById(id);
  }

  async rename(id: string, ownerId: string, title: string): Promise<IleExperience | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    return this.repo.update(id, { title });
  }

  /**
   * Duplicate an experience: same content but a fresh id, fresh history,
   * fresh version counter, status forced back to draft. The teacher can
   * then iterate on the copy without touching the original.
   */
  async duplicate(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;

    const firstSnapshot: IleVersion = {
      version: 1,
      savedAt: new Date(),
      savedBy: doc.authorName ?? ownerId,
      title: `${doc.title} (copy)`,
      html: doc.html,
      prompt: doc.prompt,
      htmlLength: doc.html.length,
    };

    const copy = new IleExperience({
      ownerId: doc.ownerId,
      authorName: doc.authorName,
      courseId: doc.courseId,
      courseVersionId: doc.courseVersionId,
      itemId: doc.itemId,
      title: firstSnapshot.title,
      prompt: doc.prompt,
      history: doc.history ?? [],
      html: doc.html,
      status: 'draft',
      versions: [firstSnapshot],
      currentVersion: 1,
    });
    return this.repo.insert(copy);
  }

  async archive(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    if (doc.status === 'archived') return doc; // idempotent
    const now = new Date();
    await this.repo.setStatus(id, 'archived', { archivedAt: now });
    return this.repo.findById(id);
  }

  async unarchive(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    if (doc.status !== 'archived') return doc; // idempotent
    // Restore to draft (not published — teacher should re-publish
    // deliberately after unarchiving).
    await this.repo.setStatus(id, 'draft', { archivedAt: null });
    return this.repo.findById(id);
  }

  /**
   * Soft delete — alias for archive. Returns true if the row was actually
   * transitioned (so the controller can return 204 vs 404).
   */
  async softDelete(id: string, ownerId: string): Promise<boolean> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return false;
    if (doc.status === 'archived') return true;
    await this.repo.setStatus(id, 'archived', { archivedAt: new Date() });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Version history

  async listVersions(
    id: string,
    ownerId: string,
  ): Promise<IleVersion[] | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    return doc.versions ?? [];
  }

  async getVersion(
    id: string,
    ownerId: string,
    version: number,
  ): Promise<IleVersion | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    return (doc.versions ?? []).find((v) => v.version === version) ?? null;
  }

  async listAll(ownerId: string, opts?: { includeArchived?: boolean }): Promise<IleExperience[]> {
    return this.repo.listByOwner(ownerId, opts);
  }

  /**
   * Restore a previous version. The restore itself becomes the new head
   * (so the action is itself a versioned save with a "restored from vN"
   * label). This keeps history append-only — we never delete snapshots.
   */
  async restoreVersion(
    id: string,
    ownerId: string,
    version: number,
    authorName?: string,
  ): Promise<IleExperience | null> {
    const doc = await this.getOwned(id, ownerId);
    if (!doc) return null;
    const target = (doc.versions ?? []).find((v) => v.version === version);
    if (!target) return null;

    // Save the restored content as a fresh version, with a label so the
    // teacher can see the provenance in the history list.
    return this.save({
      ownerId,
      authorName: authorName ?? ownerId,
      _id: id,
      courseId: doc.courseId,
      courseVersionId: doc.courseVersionId,
      itemId: doc.itemId,
      title: target.title,
      prompt: target.prompt,
      html: target.html,
      label: `Restored from v${version}`,
    });
  }
}