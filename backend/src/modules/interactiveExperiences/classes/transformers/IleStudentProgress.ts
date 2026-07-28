import { Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongodb';
import {
  ObjectIdToString,
  StringToObjectId,
} from '#root/shared/constants/transformerConstants.js';
import { ID } from '#root/shared/interfaces/models.js';
import { ILE_EVENT_KINDS } from '../validators/IleAnalyticsValidators.js';

/**
 * Lightweight event types emitted by the sandboxed ILE runtime.
 * Kept small on purpose — the student runtime batches these and posts
 * once every ~2s. The server stores a capped ring per (student,
 * experience) so the data set stays bounded.
 *
 * The union type is derived from the canonical ILE_EVENT_KINDS list
 * exported by IleAnalyticsValidators — that one `as const` array is
 * the single source of truth for the kind set.
 */
export type IleStudentEventKind = (typeof ILE_EVENT_KINDS)[number];

export interface IleStudentEvent {
  /** Discriminator for what happened. */
  kind: IleStudentEventKind;
  /** Server time when the event was received. Set by the controller. */
  receivedAt: Date;
  /**
   * Client-reported timestamp in epoch ms. Best-effort — we use it to
   * compute active-time deltas. Never used for authorisation.
   */
  clientTs: number;
  /**
   * Free-form payload. For 'progress' this is `{ percent: number }`.
   * For 'interaction' this is `{ kind: string, label?: string }`.
   * For 'resume' this is `{ reason: 'visibility' | 'navigation' }`.
   */
  data?: Record<string, unknown>;
}

export class IleStudentProgress {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  /** The ILE experience this row tracks progress against. */
  @Expose()
  experienceId: string;

  /**
   * The student's stable identifier — a salted hash of the auth token +
   * experience id, computed server-side. We never see the raw token
   * and we never persist it; the teacher sees only this hash.
   */
  @Expose()
  studentHash: string;

  /** Course context for filter / group-by. */
  @Expose()
  courseId: string;

  @Expose()
  courseVersionId: string;

  /** When this student first opened the experience. */
  @Expose()
  startedAt: Date;

  /** Most recent event we received. Drives "last seen" displays. */
  @Expose()
  lastEventAt: Date;

  /** Set when the first 'complete' event lands. */
  @Expose()
  completedAt?: Date;

  /** Last reported progress percent (0..100). -1 if never reported. */
  @Expose()
  lastProgressPct: number;

  /**
   * Cumulative active engagement in milliseconds. We sum the deltas
   * between consecutive events, clamping each gap at 5min so a student
   * who leaves the tab open for an hour doesn't inflate the metric.
   */
  @Expose()
  timeActiveMs: number;

  @Expose()
  interactionCount: number;

  @Expose()
  errorCount: number;

  /**
   * How many times the student resumed (visibility / navigation
   * events). Distinct from interactionCount.
   */
  @Expose()
  resumeCount: number;

  /**
   * How many times the student triggered an explicit retry. Distinct
   * from interactionCount — we surface this as its own metric so a
   * high retry rate can be correlated with difficult content.
   */
  @Expose()
  retryCount: number;

  /**
   * Server-derived "where the student was" snapshot stamped onto each
   * 'resume' event. We compute it server-side from the most recent
   * progress + interaction events so the wire payload stays small
   * (no extra client round-trips) and dashboards get a single
   * authoritative answer. `at` is the server receivedAt of the
   * resume event; `percent` and `label` are best-effort (omit if
   * there was no prior progress / interaction to derive from).
   */
  @Expose()
  resumePoint?: { percent?: number; at: Date; label?: string | null };

  /**
   * Bounded ring of the most recent events. Capped server-side so a
   * malicious or runaway client can't grow the document unboundedly.
   */
  @Expose()
  events: IleStudentEvent[];

  constructor(init: Partial<IleStudentProgress> = {}) {
    this._id = init._id ?? new ObjectId();
    this.experienceId = init.experienceId ?? '';
    this.studentHash = init.studentHash ?? '';
    this.courseId = init.courseId ?? '';
    this.courseVersionId = init.courseVersionId ?? '';
    this.startedAt = init.startedAt ?? new Date();
    this.lastEventAt = init.lastEventAt ?? this.startedAt;
    this.completedAt = init.completedAt;
    this.lastProgressPct = init.lastProgressPct ?? -1;
    this.timeActiveMs = init.timeActiveMs ?? 0;
    this.interactionCount = init.interactionCount ?? 0;
    this.errorCount = init.errorCount ?? 0;
    this.resumeCount = init.resumeCount ?? 0;
    this.retryCount = init.retryCount ?? 0;
    this.resumePoint = init.resumePoint;
    this.events = init.events ?? [];
  }
}