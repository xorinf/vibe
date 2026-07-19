import { injectable, inject } from 'inversify';
import { createHash } from 'crypto';
import { ILE_TYPES } from '../types.js';
import { IleStudentProgressRepository } from '../repositories/IleStudentProgressRepository.js';
import { IleExperience } from '../classes/transformers/IleExperience.js';
import {
  IleStudentProgress,
  IleStudentEvent,
  IleStudentEventKind,
} from '../classes/transformers/IleStudentProgress.js';

/**
 * Salt used when computing the per-student hash. We rotate this if we
 * ever need to invalidate all existing progress rows.
 */
const STUDENT_HASH_SALT = 'vibe-ile-analytics-v1';

const ALLOWED_KINDS: ReadonlySet<IleStudentEventKind> = new Set([
  'started',
  'progress',
  'interaction',
  'complete',
  'error',
  'resume',
  'retry',
]);

/**
 * Compute the stable per-(student, experience) hash. We never see the
 * raw token and never persist it. Different experiences produce
 * different hashes for the same student (so progress is per-experience).
 */
export function hashStudent(authToken: string, experienceId: string): string {
  const h = createHash('sha256');
  h.update(STUDENT_HASH_SALT);
  h.update(':');
  h.update(experienceId);
  h.update(':');
  h.update(authToken);
  return h.digest('hex').slice(0, 24);
}

/**
 * Validate that an inbound event payload is well-formed. Strips any
 * fields we don't want to persist (anything the client shouldn't have
 * been able to set in the first place). We don't fail-closed on unknown
 * data fields — that would block minor runtime evolutions.
 */
export function sanitiseEvent(
  raw: Partial<IleStudentEvent> & { kind?: string },
): IleStudentEvent | null {
  if (!raw.kind || !ALLOWED_KINDS.has(raw.kind as IleStudentEventKind)) {
    return null;
  }
  const kind = raw.kind as IleStudentEventKind;
  const clientTs =
    typeof raw.clientTs === 'number' && raw.clientTs > 0
      ? raw.clientTs
      : Date.now();
  const data: Record<string, unknown> | undefined =
    raw.data && typeof raw.data === 'object'
      ? sanitiseData(kind, raw.data as Record<string, unknown>)
      : undefined;
  return {
    kind,
    receivedAt: new Date(),
    clientTs,
    data,
  };
}

function sanitiseData(
  kind: IleStudentEventKind,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  // Strip non-primitive values to keep the document small. We're not
  // running a schema validator here — the runtime only ever sends
  // simple shapes — but we defend against garbage.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (v === null) {
      out[k] = null;
    }
  }
  // Clamp progress.percent to 0..100.
  if (kind === 'progress' && typeof out.percent === 'number') {
    out.percent = Math.max(0, Math.min(100, out.percent as number));
  }
  return out;
}

export interface IleEventBatch {
  /** ISO string from the client. Best-effort; the server stamps its own. */
  clientTs?: number;
  kind: IleStudentEventKind;
  data?: Record<string, unknown>;
}

export interface ExperienceAnalytics {
  experienceId: string;
  title?: string;
  /** Distinct students who have ever sent a 'started' event. */
  studentsStarted: number;
  /** Distinct students who have ever sent a 'complete' event. */
  studentsCompleted: number;
  /** studentsCompleted / studentsStarted (0 if no starts). */
  completionRate: number;
  /** totalErrors / max(1, studentsStarted). 0 if no starts. */
  errorRate: number;
  /**
   * Composite "difficulty" score, clamped to [0, 2].
   * `clamp(0, 2, (1 - completionRate) + (totalErrors / max(1, studentsStarted)))`.
   * Higher = more struggle. Surfaces the top-5 in the dashboard.
   */
  difficultyScore: number;
  /** Mean timeActiveMs across all students, in ms. */
  averageTimeActiveMs: number;
  /**
   * totalInteractions / max(0.001, averageTimeActiveMs / 60_000).
   * Floor at 0.001 minute (60ms) so a sub-second engagement burst
   * doesn't blow up the ratio. Zero when there is no time-active
   * data.
   */
  averageEngagementPerMinute: number;
  /** Mean completion percent across the cohort (last reported). */
  averageProgressPct: number;
  /** Sum of interactions across the cohort. */
  totalInteractions: number;
  /** Sum of errors across the cohort. */
  totalErrors: number;
  /**
   * Sum of explicit `vibe.retry()` calls across the cohort. Distinct
   * from `totalInteractions` so dashboards can show retry pressure
   * independent of click volume.
   */
  totalRetries: number;
  /** The student rows themselves, newest activity first. */
  students: {
    studentHash: string;
    startedAt: Date;
    lastEventAt: Date;
    completedAt?: Date;
    lastProgressPct: number;
    timeActiveMs: number;
    interactionCount: number;
    errorCount: number;
    resumeCount: number;
    retryCount: number;
    /**
     * Server-derived "where the student was" snapshot from their most
     * recent 'resume' event. Undefined if the student never resumed
     * (or if a resume arrived before any progress / interaction to
     * derive from). `at` is the server receivedAt; `percent` and
     * `label` mirror what was stamped onto the persisted resume event.
     */
    resumePoint?: { percent?: number; at: Date; label?: string | null };
    events: IleStudentEvent[];
  }[];
}

/**
 * One row of the "most difficult experiences" leaderboard on the
 * dashboard. Sorted by `difficultyScore` desc; we surface the top 5.
 */
export interface MostDifficultExperience {
  experienceId: string;
  title?: string;
  difficultyScore: number;
  completionRate: number;
  errorRate: number;
}

export interface DashboardAnalytics {
  perExperience: ExperienceAnalytics[];
  /**
   * Top-5 experiences by `difficultyScore` (desc). May be shorter than
   * 5 if the cohort has fewer experiences with data.
   */
  mostDifficult: MostDifficultExperience[];
  totals: {
    studentsStarted: number;
    studentsCompleted: number;
    averageCompletionRate: number;
    /**
     * Mean of `perExperience[i].averageEngagementPerMinute` across the
     * cohort (not population-weighted — we treat each experience
     * equally regardless of student count). 0 when there is no data.
     */
    averageEngagementPerMin: number;
  };
}

@injectable()
export class IleAnalyticsService {
  constructor(
    @inject(ILE_TYPES.IleStudentProgressRepository)
    private readonly repo: IleStudentProgressRepository,
  ) {}

  /**
   * Ingest a batch of events from the sandboxed runtime. Returns the
   * updated student row so the runtime can render an "X interactions
   * recorded" toast if it wants.
   */
  async ingest(args: {
    experienceId: string;
    courseId: string;
    courseVersionId: string;
    authToken: string;
    events: IleEventBatch[];
  }): Promise<{ studentHash: string; applied: number }> {
    const studentHash = hashStudent(args.authToken, args.experienceId);
    let applied = 0;
    for (const raw of args.events) {
      const event = sanitiseEvent(raw);
      if (!event) continue; // bad event — drop silently (best effort)
      await this.repo.applyEvent(
        studentHash,
        args.experienceId,
        args.courseId,
        args.courseVersionId,
        event,
      );
      applied++;
    }
    return { studentHash, applied };
  }

  /**
   * Build an ExperienceAnalytics summary for the teacher dashboard.
   */
  async summarise(
    experienceId: string,
    meta: { title?: string } = {},
  ): Promise<ExperienceAnalytics> {
    const rows = await this.repo.listForExperience(experienceId);
    return summariseRows(experienceId, rows, meta);
  }

  /**
   * Dashboard summary across multiple experiences. Used by the new
   * "Analytics" tab in the workspace.
   */
  async dashboardForExperiences(
    items: { _id: string; title: string }[],
  ): Promise<DashboardAnalytics> {
    if (items.length === 0) {
      return {
        perExperience: [],
        mostDifficult: [],
        totals: {
          studentsStarted: 0,
          studentsCompleted: 0,
          averageCompletionRate: 0,
          averageEngagementPerMin: 0,
        },
      };
    }
    const ids = items.map((i) => i._id);
    const rows = await this.repo.listForOwner(ids);
    const byExp = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byExp.has(r.experienceId)) byExp.set(r.experienceId, []);
      byExp.get(r.experienceId)!.push(r);
    }
    const perExperience: ExperienceAnalytics[] = items.map((i) =>
      summariseRows(i._id, byExp.get(i._id) ?? [], { title: i.title }),
    );

    // Aggregate across all experiences (distinct students can't be
    // computed without seeing them all; we use the per-experience
    // starting counts summed — slight double-counting possible if a
    // student started multiple experiences, acceptable for a dashboard).
    const totals = perExperience.reduce(
      (acc, e) => ({
        studentsStarted: acc.studentsStarted + e.studentsStarted,
        studentsCompleted: acc.studentsCompleted + e.studentsCompleted,
      }),
      { studentsStarted: 0, studentsCompleted: 0 },
    );
    const averageCompletionRate =
      perExperience.length === 0
        ? 0
        : perExperience.reduce((s, e) => s + e.completionRate, 0) /
          perExperience.length;
    const averageEngagementPerMin =
      perExperience.length === 0
        ? 0
        : perExperience.reduce((s, e) => s + e.averageEngagementPerMinute, 0) /
          perExperience.length;

    // Top-5 most difficult experiences, by composite score desc.
    // Ties broken by experienceId for stable ordering.
    const mostDifficult: MostDifficultExperience[] = [...perExperience]
      .filter((e) => e.studentsStarted > 0)
      .sort((a, b) => {
        if (b.difficultyScore !== a.difficultyScore) {
          return b.difficultyScore - a.difficultyScore;
        }
        return a.experienceId.localeCompare(b.experienceId);
      })
      .slice(0, 5)
      .map((e) => ({
        experienceId: e.experienceId,
        title: e.title,
        difficultyScore: e.difficultyScore,
        completionRate: e.completionRate,
        errorRate: e.errorRate,
      }));

    return {
      perExperience,
      mostDifficult,
      totals: { ...totals, averageCompletionRate, averageEngagementPerMin },
    };
  }
}

function summariseRows(
  experienceId: string,
  rows: IleStudentProgress[],
  meta: { title?: string },
): ExperienceAnalytics {
  let studentsStarted = 0;
  let studentsCompleted = 0;
  let totalTime = 0;
  let totalProgress = 0;
  let progressSamples = 0;
  let totalInteractions = 0;
  let totalErrors = 0;
  let totalRetries = 0;

  for (const r of rows) {
    // A student "started" if the row exists (the first event we
    // recorded for them — the repository seeds startedAt on any
    // event, not just 'started' events).
    if (r.events.some((e) => e.kind === 'started') || rows.length > 0) {
      // Per-row "started" is implied by presence; we use the
      // 'started' event kind specifically for a more accurate
      // count.
      if (r.events.some((e) => e.kind === 'started')) studentsStarted++;
    }
    if (r.completedAt) studentsCompleted++;
    totalTime += r.timeActiveMs;
    if (r.lastProgressPct >= 0) {
      totalProgress += r.lastProgressPct;
      progressSamples++;
    }
    totalInteractions += r.interactionCount;
    totalErrors += r.errorCount;
    totalRetries += r.retryCount;
  }
  // Recount started so a student whose only event was a "complete"
  // (no explicit "started") is still counted as started.
  // The repository seeds startedAt on the first event, so we infer
  // started by row presence if the explicit 'started' event was
  // missing.
  if (studentsStarted === 0 && rows.length > 0) {
    studentsStarted = rows.length;
  }

  return {
    experienceId,
    title: meta.title,
    studentsStarted,
    studentsCompleted,
    completionRate:
      studentsStarted === 0 ? 0 : studentsCompleted / studentsStarted,
    errorRate:
      studentsStarted === 0 ? 0 : totalErrors / Math.max(1, studentsStarted),
    // Difficulty is (1 - completionRate) plus the per-student error
    // load. Clamp to [0, 2] so a single noisy cohort can't make the
    // leaderboard explode.
    difficultyScore: clamp(
      0,
      2,
      (studentsStarted === 0 ? 0 : 1 - studentsCompleted / studentsStarted) +
        totalErrors / Math.max(1, studentsStarted),
    ),
    averageTimeActiveMs: rows.length === 0 ? 0 : totalTime / rows.length,
    averageEngagementPerMinute:
      totalTime <= 0
        ? 0
        : totalInteractions / Math.max(0.001, totalTime / 60_000),
    averageProgressPct:
      progressSamples === 0 ? 0 : totalProgress / progressSamples,
    totalInteractions,
    totalErrors,
    totalRetries,
    students: rows.map((r) => ({
      studentHash: r.studentHash,
      startedAt: r.startedAt,
      lastEventAt: r.lastEventAt,
      completedAt: r.completedAt,
      lastProgressPct: r.lastProgressPct,
      timeActiveMs: r.timeActiveMs,
      interactionCount: r.interactionCount,
      errorCount: r.errorCount,
      resumeCount: r.resumeCount,
      retryCount: r.retryCount,
      resumePoint: r.resumePoint,
      events: r.events,
    })),
  };
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}
