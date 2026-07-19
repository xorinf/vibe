import { injectable } from 'inversify';
import { Collection, ObjectId } from 'mongodb';
import { MongoDatabase } from '#shared/database/index.js';
import { IleStudentProgress, IleStudentEvent } from '../classes/transformers/IleStudentProgress.js';

const COLLECTION = 'ile_student_progress';

const EVENTS_RING_SIZE = 200;
const ACTIVE_GAP_CLAMP_MS = 5 * 60 * 1000;

/**
 * Repository for student progress rows. One document per
 * (studentHash, experienceId). Aggregation queries stay cheap because
 * every query is a single (hash, experience) lookup.
 */
@injectable()
export class IleStudentProgressRepository {
  /**
   * Idempotent. Set by the first call to {@link ensureIndexes}. Cached
   * so concurrent callers don't race the `createIndex` call.
   */
  private indexesReady?: Promise<void>;

  constructor(private readonly db: MongoDatabase) {}

  private async col(): Promise<Collection<IleStudentProgress>> {
    await this.ensureIndexes();
    return this.db.getCollection<IleStudentProgress>(COLLECTION);
  }

  /**
   * Create the unique (studentHash, experienceId) index. This is what
   * makes the insert in {@link applyEvent} race-safe — a second insert
   * with the same pair raises a duplicate-key error (E11000) instead
   * of silently producing two rows. `createIndex` is idempotent so
   * repeated calls are cheap.
   */
  async ensureIndexes(): Promise<void> {
    if (this.indexesReady) return this.indexesReady;
    this.indexesReady = (async () => {
      const col = await this.db.getCollection<IleStudentProgress>(COLLECTION);
      await col.createIndex(
        { studentHash: 1, experienceId: 1 },
        { unique: true, name: 'student_experience_unique' },
      );
    })();
    return this.indexesReady;
  }

  async findOne(
    studentHash: string,
    experienceId: string,
  ): Promise<IleStudentProgress | null> {
    const col = await this.col();
    return col.findOne({ studentHash, experienceId });
  }

  /**
   * Idempotent insert. We never get a write conflict because the
   * (studentHash, experienceId) tuple has a unique index downstream —
   * the controller catches the duplicate-key error and treats it as a
   * successful upsert.
   */
  async insert(doc: IleStudentProgress): Promise<void> {
    const col = await this.col();
    await col.insertOne(doc);
  }

  /**
   * Apply a batched event to the row. Pulls the latest state, applies
   * the new event(s), and writes back. Returns the new total counts so
   * the controller can surface them in the response.
   */
  async applyEvent(
    studentHash: string,
    experienceId: string,
    courseId: string,
    courseVersionId: string,
    newEvent: IleStudentEvent,
  ): Promise<IleStudentProgress> {
    const col = await this.col();
    let existing = await col.findOne({ studentHash, experienceId });

    if (!existing) {
      // First time we see this (student, experience). Create the row
      // with this single event. Duplicate-key races (two events arrive
      // in parallel for the same student) are caught here: the unique
      // (studentHash, experienceId) index raises E11000, we re-query
      // the now-existing row, and fall through to the merge branch.
      //
      // For a 'resume' event on a brand-new row there's nothing to
      // derive from yet — resumePoint stays undefined and we still
      // count the resume so analytics don't lose it.
      const resumePoint =
        newEvent.kind === 'resume' ? { at: newEvent.receivedAt } : undefined;
      const fresh = new IleStudentProgress({
        experienceId,
        studentHash,
        courseId,
        courseVersionId,
        startedAt: new Date(newEvent.receivedAt),
        lastEventAt: newEvent.receivedAt,
        lastProgressPct: deriveProgress(newEvent),
        timeActiveMs: 0,
        interactionCount: newEvent.kind === 'interaction' ? 1 : 0,
        errorCount: newEvent.kind === 'error' ? 1 : 0,
        resumeCount: newEvent.kind === 'resume' ? 1 : 0,
        retryCount: newEvent.kind === 'retry' ? 1 : 0,
        completedAt: newEvent.kind === 'complete' ? newEvent.receivedAt : undefined,
        resumePoint,
        events: [newEvent],
      });
      try {
        await col.insertOne(fresh);
        return fresh;
      } catch (err: any) {
        // Duplicate-key on (studentHash, experienceId): a sibling
        // request created the row first. Re-query and merge.
        if (err?.code === 11000) {
          const raced = await col.findOne({ studentHash, experienceId });
          if (!raced) throw err; // not actually a dup — bubble up
          existing = raced;
        } else {
          throw err;
        }
      }
    }

    // Existing row — extend it.
    const lastTs = existing.lastEventAt.getTime();
    const eventTs = newEvent.receivedAt.getTime();
    const gap = Math.min(Math.max(eventTs - lastTs, 0), ACTIVE_GAP_CLAMP_MS);

    // For 'resume' events we server-derive a "where they were" snapshot
    // from the prior events in this row and stamp it onto the event
    // BEFORE persisting so dashboards always see a self-contained
    // payload. The wire format from the client stays unchanged — the
    // client only sends `{ reason, hiddenMs }`; the server fills in
    // percent / label.
    let eventToStore = newEvent;
    let resumePoint: IleStudentProgress['resumePoint'] | undefined =
      existing.resumePoint;
    if (newEvent.kind === 'resume') {
      const derived = buildResumePayload(existing.events);
      eventToStore = {
        ...newEvent,
        data: { ...(newEvent.data ?? {}), ...derived },
      };
      resumePoint = {
        percent: derived.lastPercent,
        at: newEvent.receivedAt,
        label: derived.lastInteractionLabel ?? null,
      };
    }

    const merged: IleStudentProgress = {
      ...existing,
      lastEventAt: newEvent.receivedAt,
      completedAt:
        newEvent.kind === 'complete' && !existing.completedAt
          ? newEvent.receivedAt
          : existing.completedAt,
      lastProgressPct: deriveProgress(newEvent, existing.lastProgressPct),
      timeActiveMs: existing.timeActiveMs + gap,
      interactionCount:
        existing.interactionCount + (newEvent.kind === 'interaction' ? 1 : 0),
      errorCount: existing.errorCount + (newEvent.kind === 'error' ? 1 : 0),
      resumeCount: existing.resumeCount + (newEvent.kind === 'resume' ? 1 : 0),
      retryCount: existing.retryCount + (newEvent.kind === 'retry' ? 1 : 0),
      resumePoint,
      events: ringPush(existing.events, eventToStore, EVENTS_RING_SIZE),
    };
    await col.replaceOne({ _id: existing._id }, merged);
    return merged;
  }

  async listForExperience(experienceId: string): Promise<IleStudentProgress[]> {
    const col = await this.col();
    return col.find({ experienceId }).sort({ lastEventAt: -1 }).toArray();
  }

  async listForOwner(
    experienceIds: string[],
  ): Promise<IleStudentProgress[]> {
    if (experienceIds.length === 0) return [];
    const col = await this.col();
    return col
      .find({ experienceId: { $in: experienceIds } })
      .sort({ lastEventAt: -1 })
      .toArray();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

function deriveProgress(event: IleStudentProgress | IleStudentEvent, fallback = -1): number {
  // If the event is a progress report, take its percent. Otherwise keep
  // the existing value.
  if ('kind' in event && event.kind === 'progress') {
    const pct = (event as IleStudentEvent).data?.percent;
    if (typeof pct === 'number' && !isNaN(pct)) {
      return Math.max(0, Math.min(100, pct));
    }
  }
  return fallback;
}

function ringPush(
  existing: IleStudentEvent[],
  next: IleStudentEvent,
  max: number,
): IleStudentEvent[] {
  const arr = [...existing, next];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/**
 * Server-derive a "where the student was" payload for a 'resume'
 * event, walking the existing event ring from the most recent entry
 * backwards. We intentionally read from the existing events — not
 * from `lastProgressPct` / counts — because the student may have
 * stepped backward or jumped around, and the ring preserves that
 * narrative.
 *
 * The ring is bounded (EVENTS_RING_SIZE = 200). For typical sessions
 * that's plenty; for pathological cases we just fall back to "no
 * prior activity to report" rather than scanning Mongo again.
 */
export function buildResumePayload(
  events: IleStudentEvent[],
): { lastPercent?: number; lastInteractionLabel?: string | null } {
  let lastPercent: number | undefined;
  let lastInteractionLabel: string | null | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (lastPercent === undefined && e.kind === 'progress') {
      const pct = e.data?.percent;
      if (typeof pct === 'number' && !isNaN(pct)) {
        lastPercent = Math.max(0, Math.min(100, pct));
      }
    }
    if (
      lastInteractionLabel === undefined &&
      e.kind === 'interaction' &&
      typeof e.data?.label === 'string'
    ) {
      lastInteractionLabel = e.data.label;
    }
    if (lastPercent !== undefined && lastInteractionLabel !== undefined) break;
  }
  const out: { lastPercent?: number; lastInteractionLabel?: string | null } = {};
  if (lastPercent !== undefined) out.lastPercent = lastPercent;
  if (lastInteractionLabel !== undefined) {
    out.lastInteractionLabel = lastInteractionLabel;
  }
  return out;
}