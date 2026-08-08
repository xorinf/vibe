import { injectable, inject } from 'inversify';
import { ClientSession } from 'mongodb';
import { ForbiddenError, NotFoundError } from 'routing-controllers';
import { ILE_TYPES } from '../types.js';
import { IleRepository } from '../repositories/IleRepository.js';
import { IItemRepository } from '#shared/database/interfaces/IItemRepository.js';
import { COURSES_TYPES } from '#root/modules/courses/types.js';
import { BaseService } from '#shared/classes/BaseService.js';
import { MongoDatabase } from '#shared/database/index.js';
import { GLOBAL_TYPES } from '#root/types.js';
import {
  IleExperience,
  IleVersion,
} from '../classes/transformers/IleExperience.js';
import { ileLog } from './observability.js';

export interface SaveArgs {
  ownerId: string;
  authorName?: string;
  _id?: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  title: string;
  /**
   * Original generation prompt. Optional — see SaveIleBody docstring
   * in IleValidators.ts for the rationale. The service defaults an
   * absent value to a placeholder string so the stored doc always
   * has a non-empty prompt field (used as the experience card title
   * fallback and in the history timeline).
   */
  prompt?: string;
  html: string;
  label?: string;
}

/**
 * Pointer + status mirror the ILE controller writes into the
 * itemsGroup row when a save needs to keep the course-item view in
 * sync. The single-source-of-truth save endpoint
 * (POST /interactive-experiences/save-with-item) does this update
 * inside the same Mongo transaction that persists the ILE doc, so
 * the section's item list never points at a stale experienceId
 * even if the browser crashes mid-save.
 */
export interface IlePointerPatch {
  experienceId: string;
  status: 'draft' | 'published' | 'archived';
  currentVersion: number;
  updatedAt: number;
}

/**
 * Default title the itemsGroup row carries when an ILE is saved
 * without an explicit name. Matches the IeItem transformer's
 * `Create` path so the section's item list shows a consistent label.
 */
const DEFAULT_ITEM_NAME = 'Interactive Experience';
const DEFAULT_ITEM_DESCRIPTION = 'Interactive learning experience';
const DEFAULT_PROMPT = '(no prompt recorded)';

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
export class IleService extends BaseService {
  constructor(
    @inject(GLOBAL_TYPES.Database) db: MongoDatabase,
    @inject(ILE_TYPES.IleRepository) private readonly repo: IleRepository,
    @inject(COURSES_TYPES.ItemRepo) private readonly itemRepo: IItemRepository,
  ) {
    super(db);
  }

  /**
   * Save is now always versioned AND atomic. First save seeds version 1;
   * subsequent saves append a new snapshot and bump `currentVersion` in
   * the same Mongo transaction as the head-field update. The head
   * fields (`html`, `title`, `prompt`) stay in sync with the latest.
   *
   * NOTE (2026-08-07 audit fix): the previous implementation called
   * `repo.update()` + `repo.appendVersion()` as two separate round
   * trips. A crash between them left a doc with the new head fields
   * but no version snapshot, which silently broke version-history UI
   * (the head and the versions array fell out of sync). Routing the
   * whole flow through `persistIleDoc` (which runs in a session) keeps
   * both writes under the same transaction contract as `saveAndSync`.
   */
  async save(args: SaveArgs): Promise<IleExperience> {
    return this._withTransaction(async (session) => {
      return this.persistIleDoc(args, session);
    });
  }

  async get(id: string): Promise<IleExperience | null> {
    return this.repo.findById(id);
  }

  /**
   * Save the ILE doc and patch the matching itemsGroup row in the
   * SAME Mongo transaction. Both writes commit together or roll
   * back together. Without this, a crash between the two writes
   * leaves the section's item list pointing at a stale experienceId
   * (the orphan-row bug the old frontend-only sync had).
   *
   * The itemsGroup $set is best-effort within the transaction: if
   * the `itemId` doesn't match an existing row, the ILE save still
   * succeeds — this lets the ILE library (where experiences exist
   * outside any course) keep working without surfacing a confusing
   * 404 to the teacher.
   *
   * Returns `{ ile, item? }` so the controller can pass the
   * post-save itemsGroup state back to the frontend, which then
   * updates the section's status pill without a follow-up GET.
   */
  async saveAndSync(
    args: SaveArgs,
    pointer: { itemId?: string } | undefined,
  ): Promise<{ ile: IleExperience; item?: any }> {
    const targetItemId = pointer?.itemId ?? args.itemId;
    const startedAt = Date.now();
    try {
      const result = await this._withTransaction(async (session) => {
        const ile = await this.persistIleDoc(args, session);
        const item = targetItemId
          ? await this.tryPatchItemsGroupPointer(
              targetItemId,
              ile,
              args.title,
              session,
            )
          : null;
        return { ile, item };
      });
      ileLog('info', 'ile.save_with_item.committed', {
        ileId: result.ile._id?.toString(),
        ownerId: args.ownerId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        itemId: targetItemId ?? null,
        isFresh: !args._id,
        currentVersion: result.ile.currentVersion,
        itemsGroupPatched: Boolean(result.item),
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (err: any) {
      // Don't log the raw ILE HTML — the user may have pasted
      // sensitive content. We log a redacted payload length so
      // observability still has a useful signal without leaking
      // teacher-authored content into the log stream.
      ileLog('error', 'ile.save_with_item.failed', {
        ownerId: args.ownerId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        itemId: targetItemId ?? null,
        isFresh: !args._id,
        htmlLength: args.html.length,
        elapsedMs: Date.now() - startedAt,
        errorName: err?.name ?? 'Error',
        errorMessage: err?.message ?? 'Unknown error',
      });
      throw err;
    }
  }

  /**
   * Insert a brand-new ILE doc (or update an existing one) and
   * append a fresh version snapshot. Pure ILE-doc work — no
   * itemsGroup side effects. The session is shared with the caller
   * so the surrounding transaction can commit/rollback as one.
   */
  private async persistIleDoc(
    args: SaveArgs,
    session: ClientSession,
  ): Promise<IleExperience> {
    if (args._id) {
      return this.updateExistingIle(args, session);
    }
    return this.insertFreshIle(args, session);
  }

  private async insertFreshIle(
    args: SaveArgs,
    session: ClientSession,
  ): Promise<IleExperience> {
    const savedBy = args.authorName || args.ownerId;
    const prompt = this.normalizePrompt(args.prompt);
    const firstSnapshot: IleVersion = {
      version: 1,
      savedAt: new Date(),
      savedBy,
      title: args.title,
      html: args.html,
      prompt,
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
      prompt,
      history: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: 'Manually saved', html: args.html },
      ],
      html: args.html,
      status: 'draft',
      versions: [firstSnapshot],
      currentVersion: 1,
    });
    return this.repo.insert(fresh, session);
  }

  private async updateExistingIle(
    args: SaveArgs,
    session: ClientSession,
  ): Promise<IleExperience> {
    const savedBy = args.authorName || args.ownerId;
    const prompt = this.normalizePrompt(args.prompt);
    const saved = await this.repo.saveAndAppendVersion(
      args._id!,
      {
        title: args.title,
        html: args.html,
        prompt,
        itemId: args.itemId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        authorName: savedBy,
      },
      {
        savedBy,
        title: args.title,
        html: args.html,
        prompt,
        label: args.label,
      },
      session,
    );
    if (!saved) {
      throw new Error('Experience not found');
    }
    return saved;
  }

  /**
   * Patch the itemsGroup row's `details.experienceId` + status +
   * currentVersion in the SAME transaction as the ILE doc save.
   * Returns null when the row doesn't exist (library-only saves)
   * so the surrounding transaction can still commit. Any other
   * error (auth, schema, etc.) propagates so the whole save rolls
   * back.
   */
  private async tryPatchItemsGroupPointer(
    itemId: string,
    ile: IleExperience,
    title: string,
    session: ClientSession,
  ): Promise<any | null> {
    const ileDetails = this.buildPointerPatch(ile);
    try {
      return await this.itemRepo.updateItem(
        itemId,
        {
          type: 'INTERACTIVE_EXPERIENCE',
          name: title || DEFAULT_ITEM_NAME,
          description: DEFAULT_ITEM_DESCRIPTION,
          ileDetails: ileDetails as any,
        } as any,
        session,
      );
    } catch (err: any) {
      // Library-only saves: the itemsGroup row doesn't exist. Don't
      // fail the ILE save — the ILE doc is still the source of
      // truth. Other errors (validation, perms) propagate so the
      // whole save rolls back.
      if (this.isMissingRowError(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Build the itemsGroup pointer shape the repository's
   * `$set ileDetails` writes. Centralized so the wire format lives
   * in exactly one place and the `updatedAt` epoch-millis contract
   * is consistent between the ILE doc and the itemsGroup mirror.
   */
  private buildPointerPatch(ile: IleExperience): IlePointerPatch {
    return {
      experienceId: ile._id!.toString(),
      status: (ile.status ?? 'draft') as IlePointerPatch['status'],
      currentVersion: ile.currentVersion ?? 1,
      updatedAt: ile.updatedAt
        ? new Date(ile.updatedAt).getTime()
        : Date.now(),
    };
  }

  /**
   * Treat the ILE prompt as always-non-empty. Saves without a
   * recorded prompt (e.g. imported/cloned experiences, mid-edit
   * saves) get a friendly placeholder so the doc's prompt field
   * never trips the validator's `@IsNotEmpty`.
   */
  private normalizePrompt(prompt: string | undefined): string {
    return (prompt ?? '').trim() || DEFAULT_PROMPT;
  }

  /**
   * Heuristic for "row doesn't exist" errors thrown by the
   * ItemRepository. The repository uses routing-controllers' own
   * `NotFoundError` for these, but it can also come through as a
   * plain Error from older code paths. We match on both shapes so
   * the catch block in `tryPatchItemsGroupPointer` doesn't get
   * fooled by an unrelated error.
   */
  private isMissingRowError(err: any): boolean {
    return (
      err?.name === 'NotFoundError' ||
      /not\s*found/i.test(String(err?.message ?? ''))
    );
  }

  async getOwned(id: string, ownerId: string): Promise<IleExperience | null> {
    const doc = await this.repo.findById(id);
    if (!doc) return null;
    if (doc.ownerId !== ownerId) return null;
    return doc;
  }

  /**
   * Wire an existing ILE doc to a course item. Used by the
   * "Link existing experience" picker in the inline view.
   *
   * Distinct from `saveAndSync`:
   *   - The ILE doc is NOT re-saved. We only update the head
   *     field `itemId` so the doc knows which itemsGroup row
   *     points at it. No new version snapshot.
   *   - The transaction is small but the same atomicity
   *     contract: both writes commit or both roll back. A
   *     crash between the ILE `itemId` flip and the itemsGroup
   *     `$set` would leave the row pointing at a doc that
   *     doesn't know about it.
   *   - The itemsGroup patch is best-effort: if the row
   *     doesn't exist (orphan reference) we still update
   *     the ILE doc. The ILE doc is the source of truth.
   *
   * Auth: caller must be the ILE's owner. We do NOT check
   * course-level permissions here — a teacher who owns an
   * ILE should be able to attach it to any course item, not
   * just ones they're enrolled as an instructor in. The
   * "course write" check is the right check for the
   * save-and-create flow, not the link flow.
   */
  async linkItem(
    ileId: string,
    ownerId: string,
    args: {
      courseId: string;
      courseVersionId: string;
      itemId: string;
      label?: string;
    },
  ): Promise<{ ile: IleExperience; item?: any }> {
    return this._withTransaction(async (session) => {
      // 1. Confirm the ILE doc exists and is owned by the
      //    caller. We do this in the same transaction so a
      //    doc deleted between the check and the update
      //    can't slip through.
      const existing = await this.repo.findById(ileId, session);
      if (!existing) {
        throw new NotFoundError('Experience not found');
      }
      if (existing.ownerId !== ownerId) {
        // The ILE exists but the caller doesn't own it.
        // Throw a routing-controllers ForbiddenError directly
        // so the HTTP layer maps it to 403 with the standard
        // error envelope — no controller-side translation
        // hop required.
        throw new ForbiddenError(
          'You do not have permission to link this experience',
        );
      }

      // 2. Update the ILE doc's `itemId` head field. We
      //    intentionally do NOT touch the title / html /
      //    prompt / currentVersion — the link operation
      //    only updates which itemsGroup row the doc is
      //    bound to. No new version snapshot.
      const updated = await this.repo.update(
        ileId,
        {
          itemId: args.itemId,
          courseId: args.courseId,
          courseVersionId: args.courseVersionId,
        },
        session,
      );
      if (!updated) {
        throw new Error('Experience not found during link');
      }

      // 3. Patch the itemsGroup row in the same transaction.
      //    Best-effort: if the row doesn't exist (legacy data,
      //    wrong itemId) we still report the ILE patch as
      //    successful and surface `item: null` to the caller.
      const item = await this.tryPatchItemsGroupPointer(
        args.itemId,
        updated,
        updated.title,
        session,
      );

      return { ile: updated, item };
    });
  }

  /**
   * For student playback we return any non-archived experience that
   * has actual HTML content. We intentionally omit the chat history.
   *
   * The previous version gated on `status === 'published'`; that
   * silently broke the "teacher added an ILE item to a module
   * section, student opens it, sees nothing" case because every
   * fresh ILE ships as `draft` (insertFreshIle sets the default).
   * The teacher adding the ILE to a section is the intent signal
   * — a draft that's bound to a course item is meant to be played.
   * Archived is still a hard gate (soft-deleted → not playable).
   */
  async getPublishedForStudent(
    id: string,
  ): Promise<Pick<IleExperience, '_id' | 'title' | 'html' | 'courseId' | 'courseVersionId'> | null> {
    const doc = await this.repo.findById(id);
    if (!doc) return null;
    // Archived → not playable, even if it was published before.
    if (doc.status === 'archived') return null;
    // No content yet → nothing to render. Refusing here prevents the
    // student from seeing a blank iframe and confusing it with a
    // broken experience.
    if (!doc.html || doc.html.trim() === '') return null;
    return {
      _id: doc._id,
      title: doc.title,
      html: doc.html,
      courseId: doc.courseId,
      courseVersionId: doc.courseVersionId,
    };
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