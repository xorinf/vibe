import { Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongodb';
import {
  ObjectIdToString,
  StringToObjectId,
} from '#root/shared/constants/transformerConstants.js';
import { ID } from '#root/shared/interfaces/models.js';

/**
 * Lifecycle status for an experience.
 *
 *  - draft: teacher-owned, may not be playable by students.
 *  - published: teacher-owned, playable by students via /:id/play.
 *  - archived: soft-deleted. Hidden from students; still listed for the
 *    owner so they can unarchive or view its history.
 */
export type IleStatus = 'draft' | 'published' | 'archived';

/**
 * Lightweight reference to the source an experience was generated
 * from. NEVER carries raw transcript content — we always rebuild
 * transcripts on generate so the storage cost stays flat.
 *
 * `source` mirrors the ContextSourceId enum (kept loose here so the
 * transformer doesn't import the context module and create a cycle).
 */
export interface IleContextRef {
  /** Source identifier, e.g. 'youtube'. */
  source: string;
  /** Original input as the teacher provided it (URL, file id). */
  sourceUrl: string;
  /** Display title of the source (e.g. YouTube video title). */
  title: string;
  /** Which strategy succeeded, e.g. 'creator-captions', 'auto-captions', 'whisper'. */
  provider: string;
  /**
   * SHA-256 of the cleaned transcript text. Used as a future cache
   * key — two experiences with the same hash were generated from
   * effectively the same source content.
   */
  transcriptHash: string;
  /** When the context was first extracted. */
  createdAt: Date;
}

export interface IleHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  // When role === 'assistant', the html snapshot at the end of that turn.
  // Lets a teacher scrub through past versions without re-querying the LLM.
  html?: string;
}

/**
 * Snapshot of a saved state. Every successful Save appends one entry here;
 * the document's `html` / `title` / `prompt` always reflect the head
 * (most recent) version so existing reads don't change.
 */
export interface IleVersion {
  /** Monotonically increasing per-experience, starts at 1. */
  version: number;
  savedAt: Date;
  savedBy: string;
  title: string;
  html: string;
  prompt: string;
  /** Optional short label the teacher can attach to this save. */
  label?: string;
  /** HTML byte length — precomputed so the list endpoint stays cheap. */
  htmlLength: number;
}

export class IleExperience {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  courseId: string;

  @Expose()
  courseVersionId: string;

  // Optional — an experience can exist without being attached to an item
  // (e.g. a draft the teacher is still working on in /teacher/ile/new).
  @Expose()
  itemId?: string;

  @Expose()
  ownerId: string;

  @Expose()
  title: string;

  @Expose()
  prompt: string;

  @Expose()
  history: IleHistoryTurn[];

  /**
   * Head HTML — the most recent snapshot. Persisted alongside the
   * versions[] array so existing readers see the live state.
   */
  @Expose()
  html: string;

  @Expose()
  status: IleStatus;

  /**
   * Soft-delete marker. Set when status transitions to 'archived'. Distinct
   * from `updatedAt` so we can render "Archived on …" reliably.
   */
  @Expose()
  archivedAt?: Date;

  /**
   * Set the first time the experience is published. Survives unarchive
   * because we don't want to lose the historical "first published on" date.
   */
  @Expose()
  publishedAt?: Date;

  /**
   * Author label — typically the teacher's display name. Captured at save
   * time so the History panel can show who made each change without joining.
   */
  @Expose()
  authorName?: string;

  /**
   * Monotonically increasing counter. Increments every Save. Lets the
   * teacher see "v1 / v2 / v3" labels in the history list without
   * counting `versions.length` (which is correct, but a denormalised
   * counter is cheap and keeps the UI snappy).
   */
  @Expose()
  currentVersion: number;

  /** Per-save snapshots. Empty on documents created before versioning shipped. */
  @Expose()
  versions: IleVersion[];

  /**
   * Optional reference to the source this experience was generated
   * from. The teacher workspace surfaces this as a "Context: …"
   * chip; the student-facing endpoints strip it out (provenanced
   * source URLs are an authoring concern, not a learner one).
   *
   * No raw transcript is stored here — by design. See README §
   * Context Provider architecture.
   */
  @Expose()
  context?: IleContextRef;

  @Expose()
  createdAt: Date;
  @Expose()
  updatedAt: Date;

  constructor(init: Partial<IleExperience> = {}) {
    this._id = init._id ?? new ObjectId();
    this.courseId = init.courseId ?? '';
    this.courseVersionId = init.courseVersionId ?? '';
    this.itemId = init.itemId;
    this.ownerId = init.ownerId ?? '';
    this.title = init.title ?? 'Untitled Experience';
    this.prompt = init.prompt ?? '';
    this.history = init.history ?? [];
    this.html = init.html ?? '';
    this.status = init.status ?? 'draft';
    this.archivedAt = init.archivedAt;
    this.publishedAt = init.publishedAt;
    this.authorName = init.authorName;
    this.currentVersion = init.currentVersion ?? 0;
    this.versions = init.versions ?? [];
    this.context = init.context;
    this.createdAt = init.createdAt ?? new Date();
    this.updatedAt = init.updatedAt ?? new Date();
  }
}