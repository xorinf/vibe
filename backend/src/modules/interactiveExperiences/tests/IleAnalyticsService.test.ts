import {describe, expect, it} from 'vitest';
import {IleStudentProgressRepository} from '../repositories/IleStudentProgressRepository.js';
import {
  hashStudent,
  IleAnalyticsService,
} from '../services/IleAnalyticsService.js';
import {
  aggregateTimeSeries,
  computeDropOffCurve,
  dayArray,
} from '../analyticsHelpers.js';
import type {
  IleStudentEvent,
  IleStudentEventKind,
} from '../classes/transformers/IleStudentProgress.js';

function event(kind: IleStudentEventKind, receivedAt: string): IleStudentEvent {
  return {
    kind,
    receivedAt: new Date(receivedAt),
    clientTs: new Date(receivedAt).getTime(),
  };
}

function progressRow(args: {
  progress: number;
  events?: IleStudentEvent[];
  completed?: boolean;
  timeActiveMs?: number;
  interactions?: number;
  errors?: number;
  resumes?: number;
  retries?: number;
}) {
  const events = args.events ?? [event('started', '2026-07-01T10:00:00.000Z')];
  return {
    studentHash: `student-${args.progress}`,
    startedAt: events[0]?.receivedAt ?? new Date('2026-07-01T10:00:00.000Z'),
    lastEventAt:
      events.at(-1)?.receivedAt ?? new Date('2026-07-01T10:00:00.000Z'),
    completedAt: args.completed
      ? new Date('2026-07-01T10:10:00.000Z')
      : undefined,
    lastProgressPct: args.progress,
    timeActiveMs: args.timeActiveMs ?? 60_000,
    interactionCount: args.interactions ?? 0,
    errorCount: args.errors ?? 0,
    resumeCount: args.resumes ?? 0,
    retryCount: args.retries ?? 0,
    events,
  };
}

describe('ILE analytics helpers', () => {
  it('keeps the anonymised student id stable for a verified user', () => {
    expect(hashStudent('user-1', 'exp-1')).toBe(hashStudent('user-1', 'exp-1'));
    expect(hashStudent('user-1', 'exp-1')).not.toBe(
      hashStudent('user-1', 'exp-2'),
    );
  });

  it('builds an inclusive, zero-filled UTC day range', () => {
    expect(
      dayArray(
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ),
    ).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('buckets events and distributes active time across UTC days', () => {
    const rows = [
      {
        events: [
          event('started', '2026-07-01T10:00:00.000Z'),
          event('error', '2026-07-02T09:00:00.000Z'),
          event('retry', '2026-07-02T09:01:00.000Z'),
          event('complete', '2026-07-02T10:00:00.000Z'),
        ],
        timeActiveMs: 120_000,
        startedAt: new Date('2026-07-01T10:00:00.000Z'),
        lastEventAt: new Date('2026-07-02T10:00:00.000Z'),
      },
    ];

    expect(
      aggregateTimeSeries(
        rows,
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ),
    ).toEqual([
      {
        date: '2026-07-01',
        studentsStarted: 1,
        studentsCompleted: 0,
        errors: 0,
        retries: 0,
        resumes: 0,
        averageTimeActiveMs: 60_000,
      },
      {
        date: '2026-07-02',
        studentsStarted: 0,
        studentsCompleted: 1,
        errors: 1,
        retries: 1,
        resumes: 0,
        averageTimeActiveMs: 60_000,
      },
      {
        date: '2026-07-03',
        studentsStarted: 0,
        studentsCompleted: 0,
        errors: 0,
        retries: 0,
        resumes: 0,
        averageTimeActiveMs: 0,
      },
    ]);
  });

  it('returns a monotonic drop-off curve including the 100% completion bin', () => {
    const curve = computeDropOffCurve('exp-1', [
      {lastProgressPct: 100},
      {lastProgressPct: 55},
      {lastProgressPct: 15},
    ]);

    expect(curve.bins).toHaveLength(11);
    expect(curve.bins.at(-1)).toEqual({pct: 100, reachedBy: 1, total: 3});
    expect(curve.bins.every((bin, index) => {
      return index === 0 || bin.reachedBy <= curve.bins[index - 1].reachedBy;
    })).toBe(true);
    expect(curve.largestDrop).toEqual({
      fromPct: 10,
      toPct: 20,
      magnitude: 1 / 3,
    });
  });
});

describe('IleAnalyticsService learning intelligence', () => {
  it('computes comparison deltas as experience A minus experience B', async () => {
    const rowsByExperience = new Map([
      [
        'a',
        [
          progressRow({progress: 100, completed: true, timeActiveMs: 120_000}),
          progressRow({progress: 100, completed: true, timeActiveMs: 180_000}),
        ],
      ],
      [
        'b',
        [
          progressRow({progress: 50, timeActiveMs: 60_000, errors: 1}),
          progressRow({progress: 20, timeActiveMs: 60_000}),
        ],
      ],
    ]);
    const repo = {
      listForExperience: async (experienceId: string) =>
        rowsByExperience.get(experienceId) ?? [],
    } as unknown as IleStudentProgressRepository;
    const service = new IleAnalyticsService(repo);

    const comparison = await service.compare(
      {experienceId: 'a', title: 'A'},
      {experienceId: 'b', title: 'B'},
    );

    expect(comparison.delta.completionRate).toBe(1);
    expect(comparison.delta.averageTimeActiveMs).toBe(90_000);
    expect(comparison.delta.errorRate).toBe(-0.5);
    expect(comparison.delta.difficultyScore).toBe(-1.5);
  });

  it('emits actionable insights for low completion, errors, and drop-off', async () => {
    const rows = [
      progressRow({progress: 100, errors: 1}),
      progressRow({progress: 15, errors: 1, resumes: 1}),
      progressRow({progress: 15, errors: 1}),
    ];
    const repo = {
      listForExperience: async () => rows,
    } as unknown as IleStudentProgressRepository;
    const service = new IleAnalyticsService(repo);

    const insights = await service.insights('exp-1');
    const ids = insights.map((insight) => insight.id);

    expect(ids).toContain('low-completion');
    expect(ids).toContain('high-errors');
    expect(ids).toContain('confusing-section');
    expect(ids).toContain('resume-without-completion');
  });
});
