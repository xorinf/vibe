/**
 * Pure helper for the time-series analytics. Extracted from
 * `IleAnalyticsService.timeSeries` so it can be unit-tested without
 * spinning up mongo + the Inversify container.
 *
 * The function takes the per-row raw event lists and the desired
 * window, then produces a zero-filled daily bucket array. All date
 * math is UTC so daylight-savings changes don't produce off-by-one
 * buckets.
 */

import type {
  IleStudentEvent,
  IleStudentProgress,
} from './classes/transformers/IleStudentProgress.js';
import type {
  AnalyticsBucket,
  DropOffCurve,
} from './services/IleAnalyticsService.js';

const PROGRESS_BINS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Normalise a Date to UTC midnight. */
export function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/** Build the zero-filled day array for a [from, to] window. */
export function dayArray(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = startOfUtcDay(from).getTime(); t <= to.getTime(); t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Aggregate per-row events into the day buckets. `timeActiveMs` is
 * split evenly across the UTC days between startedAt and lastEventAt
 * for each row.
 */
export function aggregateTimeSeries(
  rows: ReadonlyArray<{
    events: IleStudentEvent[];
    timeActiveMs: number;
    startedAt: Date;
    lastEventAt: Date;
  }>,
  from: Date,
  to: Date,
): AnalyticsBucket[] {
  const days = dayArray(from, to);
  const byDate = new Map<string, AnalyticsBucket>();
  for (const d of days) {
    byDate.set(d, {
      date: d,
      studentsStarted: 0,
      studentsCompleted: 0,
      errors: 0,
      retries: 0,
      resumes: 0,
      averageTimeActiveMs: 0,
    });
  }
  const timeAcc: Record<string, { sum: number; n: number }> = {};
  for (const r of rows) {
    for (const ev of r.events) {
      const d = new Date(ev.receivedAt);
      if (d < from || d > addDays(to, 1)) continue;
      const key = d.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (!bucket) continue;
      switch (ev.kind) {
        case 'started':
          bucket.studentsStarted += 1;
          break;
        case 'complete':
          bucket.studentsCompleted += 1;
          break;
        case 'error':
          bucket.errors += 1;
          break;
        case 'retry':
          bucket.retries += 1;
          break;
        case 'resume':
          bucket.resumes += 1;
          break;
        default:
          break;
      }
    }
    // Distribute the row's time-active across its UTC days. Cheap and
    // good enough for a daily chart.
    const rowDays: string[] = [];
    for (
      let t = startOfUtcDay(r.startedAt).getTime();
      t <= startOfUtcDay(r.lastEventAt).getTime() && t <= to.getTime();
      t += MS_PER_DAY
    ) {
      const k = new Date(t).toISOString().slice(0, 10);
      if (byDate.has(k)) rowDays.push(k);
    }
    if (rowDays.length > 0) {
      const perDay = r.timeActiveMs / rowDays.length;
      for (const k of rowDays) {
        timeAcc[k] = timeAcc[k] ?? { sum: 0, n: 0 };
        timeAcc[k].sum += perDay;
        timeAcc[k].n += 1;
      }
    }
  }
  for (const [k, v] of Object.entries(timeAcc)) {
    const b = byDate.get(k);
    if (b) b.averageTimeActiveMs = v.n > 0 ? v.sum / v.n : 0;
  }
  return Array.from(byDate.values());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/**
 * Compute the drop-off curve from a per-row progress snapshot.
 * `lastProgressPct` is the highest bin the student ever reached. The
 * curve is monotonically non-increasing in bin index (reaching 50%
 * implies reaching 40%).
 */
export function computeDropOffCurve(
  experienceId: string,
  rows: ReadonlyArray<{ lastProgressPct: number }>,
): DropOffCurve {
  const total = rows.length;
  const bins = PROGRESS_BINS.map((pct) => ({
    pct,
    reachedBy: rows.filter((r) => (r.lastProgressPct ?? 0) >= pct).length,
    total,
  }));
  let largestDrop = { fromPct: 0, toPct: 0, magnitude: 0 };
  for (let i = 1; i < bins.length; i++) {
    const mag = (bins[i - 1].reachedBy - bins[i].reachedBy) / Math.max(1, total);
    if (mag > largestDrop.magnitude) {
      largestDrop = {
        fromPct: bins[i - 1].pct,
        toPct: bins[i].pct,
        magnitude: mag,
      };
    }
  }
  return { experienceId, bins, largestDrop };
}
