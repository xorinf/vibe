import { useEffect, useState } from 'react';
import {
  Loader2,
  Users,
  CheckCircle2,
  Clock,
  MousePointerClick,
  AlertCircle,
  RefreshCw,
  BarChart3,
  TrendingUp,
  Flame,
  Activity,
  RotateCw,
  CalendarClock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import { getIleExperienceAnalytics, type ExperienceAnalytics } from './ileApi';

export interface AnalyticsPanelProps {
  experienceId: string;
  className?: string;
}

/**
 * Teacher-facing analytics for one experience.
 *
 * Shows the high-level numbers (started, completed, completion rate,
 * average time, errors) plus a per-student list. The student list
 * shows only the stable hash — no personal data. Each row is expandable
 * to see the recent event timeline.
 *
 * Self-contained: fetches on mount, exposes a manual refresh.
 */
export function AnalyticsPanel({ experienceId, className }: AnalyticsPanelProps) {
  const [data, setData] = useState<ExperienceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getIleExperienceAnalytics(experienceId);
      setData(res);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load analytics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceId]);

  return (
    <div className={cn('flex h-full flex-col bg-card ', className)}>
      <div className="flex items-center justify-between border-b bg-background  px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground ">
            <BarChart3 className="h-4 w-4 text-primary/90 " />
            Student analytics
          </h2>
          <p className="text-xs text-muted-foreground ">
            Aggregated, anonymised engagement for this experience.
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={refresh}
          disabled={loading}
          className="h-8 w-8"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground ">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30  bg-destructive/15  px-3 py-2 text-xs text-destructive ">
            {error}
            <Button
              size="sm"
              variant="ghost"
              onClick={refresh}
              className="ml-2 h-6 text-destructive  hover:bg-rose-100"
            >
              Retry
            </Button>
          </div>
        ) : data ? (
          <AnalyticsContent data={data} />
        ) : null}
      </div>
    </div>
  );
}

function AnalyticsContent({ data }: { data: ExperienceAnalytics }) {
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2">
        <Stat
          icon={<Users className="h-3.5 w-3.5" />}
          label="Started"
          value={data.studentsStarted}
          tone="violet"
        />
        <Stat
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label="Completed"
          value={data.studentsCompleted}
          tone="emerald"
        />
        <Stat
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Completion"
          value={`${Math.round(data.completionRate * 100)}%`}
          tone="amber"
        />
        <Stat
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Avg time"
          value={formatDuration(data.averageTimeActiveMs)}
          tone="slate"
        />
        <Stat
          icon={<MousePointerClick className="h-3.5 w-3.5" />}
          label="Interactions"
          value={data.totalInteractions}
          tone="sky"
        />
        <Stat
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          label="Errors"
          value={data.totalErrors}
          tone={data.totalErrors > 0 ? 'rose' : 'slate'}
        />
      </section>

      <section className="grid grid-cols-3 gap-2">
        <Stat
          icon={<Flame className="h-3.5 w-3.5" />}
          label="Difficulty"
          value={data.difficultyScore.toFixed(2)}
          tone={data.difficultyScore >= 1 ? 'rose' : data.difficultyScore >= 0.5 ? 'amber' : 'slate'}
        />
        <Stat
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Engagement / min"
          value={
            data.averageEngagementPerMinute > 0
              ? data.averageEngagementPerMinute.toFixed(1)
              : '—'
          }
          tone="emerald"
        />
        <Stat
          icon={<RotateCw className="h-3.5 w-3.5" />}
          label="Retries"
          value={data.totalRetries}
          tone={data.totalRetries > 0 ? 'amber' : 'slate'}
        />
      </section>

      <CompletionTimeline students={data.students} />

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground ">
          Students ({data.students.length})
        </h3>
        {data.students.length === 0 ? (
          <p className="rounded-md border border-dashed border-border  bg-background  p-3 text-center text-xs text-muted-foreground ">
            No students have opened this experience yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.students.map((s) => (
              <StudentRow key={s.studentHash} student={s} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone: 'violet' | 'emerald' | 'amber' | 'slate' | 'sky' | 'rose';
}) {
  const toneClasses = {
    violet: 'bg-violet-50 text-violet-700 ring-violet-100',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    amber: 'bg-amber-50 text-amber-700 ring-amber-100',
    slate: 'bg-slate-50 text-slate-700 ring-slate-200',
    sky: 'bg-sky-50 text-sky-700 ring-sky-100',
    rose: 'bg-rose-50 text-rose-700 ring-rose-100',
  }[tone];
  return (
    <div className={cn('rounded-md p-2.5 ring-1', toneClasses)}>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider opacity-75">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function StudentRow({
  student,
}: {
  student: ExperienceAnalytics['students'][number];
}) {
  const [expanded, setExpanded] = useState(false);
  const startedAt = new Date(student.startedAt);
  const lastAt = new Date(student.lastEventAt);
  const completed = Boolean(student.completedAt);
  const pct = Math.max(0, Math.min(100, student.lastProgressPct));

  return (
    <li className="rounded-md border border-border  bg-background ">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[10px] text-muted-foreground ">
            {student.studentHash.slice(0, 8)}…
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground ">
            <span>
              Started {startedAt.toLocaleDateString()} {startedAt.toLocaleTimeString()}
            </span>
            <span className="text-slate-300">·</span>
            <span>last {timeAgo(lastAt)}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted ">
            <div
              className={cn(
                'h-full rounded-full',
                completed
                  ? 'bg-emerald-500'
                  : pct > 0
                  ? 'bg-violet-500'
                  : 'bg-muted ',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end text-[10px] text-muted-foreground ">
          <span className="font-semibold text-foreground/80 ">{pct}%</span>
          {student.errorCount > 0 && (
            <span className="text-destructive/90 ">{student.errorCount} err</span>
          )}
          {student.interactionCount > 0 && (
            <span className="text-muted-foreground ">{student.interactionCount} act</span>
          )}
        </div>
      </button>
      {expanded && student.events.length > 0 && (
        <div className="border-t bg-card  px-3 py-2">
          {student.resumePoint && (
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground ">
              <RotateCw className="h-2.5 w-2.5 text-violet-500" />
              <span className="font-semibold uppercase tracking-wider text-muted-foreground ">
                Resume point
              </span>
              <span className="font-mono">
                {typeof student.resumePoint.percent === 'number'
                  ? `${Math.round(student.resumePoint.percent)}%`
                  : 'no progress yet'}
              </span>
              {student.resumePoint.label && (
                <span className="truncate text-muted-foreground ">
                  · "{student.resumePoint.label}"
                </span>
              )}
              <span className="text-muted-foreground/80 ">
                · at {new Date(student.resumePoint.at).toLocaleTimeString()}
              </span>
            </p>
          )}
          <ol className="space-y-1 text-[10px] font-mono text-muted-foreground ">
            {student.events.slice(-12).map((e, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <span className="mt-0.5 text-muted-foreground/80 ">
                  {new Date(e.receivedAt).toLocaleTimeString()}
                </span>
                <span className="rounded bg-muted  px-1 text-[9px] uppercase text-foreground/80 ">
                  {e.kind}
                </span>
                {e.data != null && (
                  <span className="truncate text-muted-foreground ">
                    {JSON.stringify(e.data)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

/**
 * Cohort completion / activity timeline.
 *
 * Buckets each student into Today (last 24h touch), This week
 * (within 7d), or Earlier. The bar segments are width-proportional so
 * the visualisation doubles as a quick "where is engagement right now"
 * pulse for the cohort. Reads only the lightweight summary fields;
 * does not re-fetch anything.
 */
function CompletionTimeline({
  students,
}: {
  students: ExperienceAnalytics['students'];
}) {
  type Bucket = { label: string; count: number; tone: string; bg: string };
  const buckets: Bucket[] = [
    { label: 'Today', count: 0, tone: 'text-emerald-700', bg: 'bg-emerald-500' },
    { label: 'This week', count: 0, tone: 'text-sky-700', bg: 'bg-sky-500' },
    { label: 'Earlier', count: 0, tone: 'text-slate-600', bg: 'bg-slate-400' },
  ];

  if (students.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground ">
          Completion timeline
        </h3>
        <p className="rounded-md border border-dashed border-border  bg-background  p-3 text-center text-xs text-muted-foreground ">
          No student activity yet.
        </p>
      </section>
    );
  }

  const now = Date.now();
  for (const s of students) {
    const anchor = new Date(
      s.completedAt ?? s.lastEventAt ?? s.startedAt,
    ).getTime();
    const ageMs = now - anchor;
    if (ageMs <= 24 * 60 * 60 * 1000) buckets[0].count++;
    else if (ageMs <= 7 * 24 * 60 * 60 * 1000) buckets[1].count++;
    else buckets[2].count++;
  }
  const total = students.length;

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground ">
        <CalendarClock className="h-3 w-3" />
        Completion timeline
      </h3>
      <div className="overflow-hidden rounded-md border border-border  bg-background ">
        <div className="flex h-2 w-full overflow-hidden bg-muted ">
          {buckets.map((b) =>
            b.count > 0 ? (
              <div
                key={b.label}
                className={cn('h-full', b.bg)}
                style={{ width: `${(b.count / total) * 100}%` }}
                title={`${b.label}: ${b.count}`}
              />
            ) : null,
          )}
        </div>
        <ul className="grid grid-cols-3 divide-x divide-slate-100">
          {buckets.map((b) => (
            <li
              key={b.label}
              className="flex flex-col items-center gap-0.5 px-2 py-2 text-center"
            >
              <span className={cn('text-[10px] font-semibold uppercase tracking-wider', b.tone)}>
                {b.label}
              </span>
              <span className="text-base font-semibold text-foreground ">
                {b.count}
              </span>
              <span className="text-[10px] text-muted-foreground ">
                {Math.round((b.count / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function timeAgo(date: Date): string {
  const dt = Date.now() - date.getTime();
  if (dt < 60_000) return 'just now';
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}