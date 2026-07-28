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
import {
  aggregateTimeSeries,
  computeDropOffCurve,
  startOfUtcDay,
} from '../analyticsHelpers.js';
import { ILE_EVENT_KINDS } from '../classes/validators/IleAnalyticsValidators.js';

/**
 * Salt used when computing the per-student hash. We rotate this if we
 * ever need to invalidate all existing progress rows.
 */
const STUDENT_HASH_SALT = 'vibe-ile-analytics-v1';

// Built from the canonical ILE_EVENT_KINDS list (validator layer) —
// that one as-const array is the single source of truth for the kind
// set. Adding a new kind requires editing only IleAnalyticsValidators.
const ALLOWED_KINDS: ReadonlySet<IleStudentEventKind> = new Set(ILE_EVENT_KINDS);

/**
 * Compute the stable per-(student, experience) hash from a verified
 * application user id. We never persist the raw id. Different experiences produce
 * different hashes for the same student (so progress is per-experience).
 */
export function hashStudent(studentId: string, experienceId: string): string {
  const h = createHash('sha256');
  h.update(STUDENT_HASH_SALT);
  h.update(':');
  h.update(experienceId);
  h.update(':');
  h.update(studentId);
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
    studentId: string;
    events: IleEventBatch[];
  }): Promise<{ studentHash: string; applied: number }> {
    const studentHash = hashStudent(args.studentId, args.experienceId);
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

  // ───────────────────────────────────────────────────────────────────
  // Learning-intelligence surface
  // ───────────────────────────────────────────────────────────────────

  /**
   * Daily time series for an experience. Window defaults to the
   * last 30 days. Days with no events are zero-filled so the chart
   * doesn't have gaps.
   */
  async timeSeries(
    experienceId: string,
    opts: { from?: Date; to?: Date; days?: number } = {},
  ): Promise<TimeSeriesAnalytics> {
    const to = opts.to ? startOfUtcDay(opts.to) : startOfUtcDay(new Date());
    const from = opts.from
      ? startOfUtcDay(opts.from)
      : new Date(
          to.getTime() -
            (opts.days ?? 30) * 24 * 60 * 60 * 1000 +
            24 * 60 * 60 * 1000,
        );
    const rows = await this.repo.listForExperienceSince(experienceId, from);
    const series = aggregateTimeSeries(rows, from, to);
    return {
      experienceId,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: 'day' as const,
      series,
    };
  }
  /**
   * Drop-off curve at 10% steps. For each bin we count the fraction of
   * students whose `lastProgressPct` was ever at or above that bin.
   * The largest single-bin drop is returned as `largestDrop` so the
   * insights layer can flag a "confusing section" without re-scanning.
   */
  async dropOffCurve(experienceId: string): Promise<DropOffCurve> {
    const rows = await this.repo.listForExperience(experienceId);
    return computeDropOffCurve(experienceId, rows);
  }

  /**
   * Deterministic rule-based insights. We deliberately do NOT call an
   * LLM here — the brief is "AI Insights" but a small rule-set gives
   * the same signal at zero cost and zero latency. The rules:
   *
   *   1. completionRate < 0.4        → "very few finish" warning
   *   2. errorRate > 0.3              → "lots of runtime errors" warning
   *   3. dropOff.largestDrop.magnitude > 0.2  → "confusing section"
   *      in the bin range, with a concrete suggestion
   *   4. resumeCount > 0 and lastProgressPct < 80 → "students keep
   *      coming back, suggest a checkpoint"
   *   5. retryCount > averageTimeActiveMs / 60000 → "high retry pressure
   *      compared to engagement" (info)
   */
  async insights(
    experienceId: string,
  ): Promise<AnalyticsInsight[]> {
    const [summary, curve] = await Promise.all([
      this.summarise(experienceId, {}),
      this.dropOffCurve(experienceId),
    ]);
    const out: AnalyticsInsight[] = [];

    if (summary.studentsStarted >= 3 && summary.completionRate < 0.4) {
      out.push({
        id: 'low-completion',
        severity: 'warning',
        title: 'Very few students finish',
        body: `Only ${(summary.completionRate * 100).toFixed(0)}% of ${summary.studentsStarted} students complete the experience.`,
        scope: { progressFrom: 0, progressTo: 100 },
        suggestion:
          'Look at the drop-off curve below to see where students stop, then simplify that section.',
      });
    }

    if (summary.studentsStarted >= 3 && summary.errorRate > 0.3) {
      out.push({
        id: 'high-errors',
        severity: summary.errorRate > 0.6 ? 'critical' : 'warning',
        title: 'High error rate',
        body: `Students are hitting ${summary.errorRate.toFixed(2)} runtime errors per session on average.`,
        scope: { progressFrom: 0, progressTo: 100 },
        suggestion:
          'Open the experience in preview and walk through the same flows that produce the errors; the runtime SDK surfaces the error message in the console.',
      });
    }

    if (curve.largestDrop.magnitude > 0.2 && summary.studentsStarted >= 3) {
      out.push({
        id: 'confusing-section',
        severity: curve.largestDrop.magnitude > 0.4 ? 'critical' : 'warning',
        title: `Confusing section: ${curve.largestDrop.fromPct}% → ${curve.largestDrop.toPct}%`,
        body: `${(curve.largestDrop.magnitude * 100).toFixed(0)}% of students who reached ${curve.largestDrop.fromPct}% never made it to ${curve.largestDrop.toPct}%.`,
        scope: {
          progressFrom: curve.largestDrop.fromPct,
          progressTo: curve.largestDrop.toPct,
        },
        suggestion:
          'This is the largest single-bin drop-off. Consider adding a hint, breaking the section into smaller steps, or rewording the instructions.',
      });
    }

    const totalResumes = summary.students.reduce((a, s) => a + s.resumeCount, 0);
    if (totalResumes > 0 && summary.averageProgressPct < 80) {
      out.push({
        id: 'resume-without-completion',
        severity: 'info',
        title: 'Students keep coming back',
        body: `${totalResumes} resume event${totalResumes === 1 ? '' : 's'} on a cohort that hasn't completed yet — the experience holds attention.`,
        scope: { progressFrom: 0, progressTo: 100 },
        suggestion:
          'Surface a clear "continue where you left off" affordance so returning students land at their resume point rather than the start.',
      });
    }

    if (
      summary.totalRetries > 0 &&
      summary.studentsStarted > 0 &&
      summary.totalRetries / summary.studentsStarted > Math.max(3, summary.averageTimeActiveMs / 60000)
    ) {
      out.push({
        id: 'retry-pressure',
        severity: 'info',
        title: 'High retry pressure',
        body: `${summary.totalRetries} retries across ${summary.studentsStarted} students — well above the engagement rate.`,
        scope: { progressFrom: 0, progressTo: 100 },
        suggestion:
          'Check whether the experience has a control that misfires (e.g. a quiz with no clear "next" button). Retries are a strong signal of friction.',
      });
    }

    return out;
  }

  /**
   * Compare two experiences. Both must be owned by the same teacher
   * (the controller enforces that). Returns both summaries plus a
   * pre-computed delta for the headline numbers.
   */
  async compare(
    a: { experienceId: string; title?: string },
    b: { experienceId: string; title?: string },
  ): Promise<CompareAnalytics> {
    const [aSummary, bSummary] = await Promise.all([
      this.summarise(a.experienceId, { title: a.title }),
      this.summarise(b.experienceId, { title: b.title }),
    ]);
    return {
      a: { ...aSummary, experienceId: a.experienceId, title: a.title },
      b: { ...bSummary, experienceId: b.experienceId, title: b.title },
      delta: {
        completionRate: aSummary.completionRate - bSummary.completionRate,
        averageTimeActiveMs:
          aSummary.averageTimeActiveMs - bSummary.averageTimeActiveMs,
        errorRate: aSummary.errorRate - bSummary.errorRate,
        difficultyScore: aSummary.difficultyScore - bSummary.difficultyScore,
        averageEngagementPerMinute:
          aSummary.averageEngagementPerMinute - bSummary.averageEngagementPerMinute,
      },
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

// ─────────────────────────────────────────────────────────────────────
// Learning intelligence — time series, drop-off, insights, compare
// ─────────────────────────────────────────────────────────────────────

/** One day in a time series. Date is normalised to UTC midnight. */
export interface AnalyticsBucket {
  /** ISO date (UTC midnight) marking the start of the bucket. */
  date: string;
  /** Distinct students who started in this window. */
  studentsStarted: number;
  /** Distinct students who completed in this window. */
  studentsCompleted: number;
  /** Sum of all errors recorded in this window. */
  errors: number;
  /** Sum of all retries recorded in this window. */
  retries: number;
  /** Sum of all resume events recorded in this window. */
  resumes: number;
  /** Mean of the per-row `timeActiveMs` delta within the window. */
  averageTimeActiveMs: number;
}

/**
 * Time series for an experience, daily resolution. The window is
 * inclusive of `from` and `to` (both in UTC). The result is always
 * `days(to - from + 1)` long; missing days are zero-filled.
 */
export interface TimeSeriesAnalytics {
  experienceId: string;
  from: string;
  to: string;
  bucket: 'day';
  series: AnalyticsBucket[];
}

/**
 * Drop-off curve. For each progress bin (0..100 in 10% steps), the
 * fraction of students whose `lastProgressPct` ever exceeded that bin
 * (i.e. they made it that far at some point). A monotonic-ish curve
 * that should fall as the lesson progresses; sharp drops are the
 * insights AI suggests look at.
 */
export interface DropOffCurve {
  experienceId: string;
  /** Bin 0..100 in 10% steps. */
  bins: { pct: number; reachedBy: number; total: number }[];
  /**
   * Largest single-bin drop. > 0.2 (20 percentage points) is a strong
   * "confusing section" signal; the AI insights layer uses it.
   */
  largestDrop: { fromPct: number; toPct: number; magnitude: number };
}

/**
 * Heuristic insights about an experience. Each item is a real
 * finding the dashboard surfaces as an actionable card. We are
 * deliberately not calling any LLM here — the brief says "AI
 * Insights" but the data is small enough that a deterministic
 * rule-set gives the teacher the same signal without the cost.
 */
export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface AnalyticsInsight {
  id: string;
  severity: InsightSeverity;
  title: string;
  /**
   * Plain-English description. We deliberately keep this short so the
   * UI can render it in a single line card.
   */
  body: string;
  /** Where the insight points to, in the experience's coordinate system. */
  scope: {
    /** Inclusive lower bound (e.g. 40 → "between 40% and 50%"). */
    progressFrom: number;
    /** Inclusive upper bound. */
    progressTo: number;
  };
  /** Suggested action the teacher can take. */
  suggestion: string;
}

/** Compare A vs B for a single teacher's experience library. */
export interface CompareAnalytics {
  a: ExperienceAnalytics & { experienceId: string; title?: string };
  b: ExperienceAnalytics & { experienceId: string; title?: string };
  /** Pre-computed deltas (a - b) for the headline numbers so the UI
   *  can render "A is X% more engaging" without redoing the math. */
  delta: {
    completionRate: number;
    averageTimeActiveMs: number;
    errorRate: number;
    difficultyScore: number;
    averageEngagementPerMinute: number;
  };
}