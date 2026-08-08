/**
 * Background FIFO stream queue for ILE generation / edit.
 *
 * Why this exists
 * ---------------
 * The legacy `startEditStream` / `start` in `useIleEditor.ts` mutates a
 * single shared `stream` state slot imperatively. When a teacher sends
 * a prompt while another stream is still running, or the network drops
 * mid-flight, the consumer has to carefully set `status: 'idle'`
 * everywhere to avoid being stuck on `'streaming'` forever. The
 * `done` event sometimes races with the abort on close, sometimes
 * arrives twice, sometimes is lost in a body-buffering edge case.
 *
 * This queue wraps each stream in a `Promise` that **always settles**.
 * - On `done` SSE event → resolve with `{ html, experienceId, ... }`
 * - On `error` SSE event → reject
 * - On transport failure (network, abort, JSON parse, idle timeout) → reject
 * - On cancel() while in-flight → reject with `AbortError`-like
 *
 * The promise is the source of truth. The consumer hook awaits it
 * (or `.then().catch()`) and drives its React state from the
 * resolution — no more manual state-machine bookkeeping for
 * "did the stream finish or did it die?"
 *
 * Job model
 * ---------
 * Jobs run **sequentially** in FIFO order. If a teacher sends
 * prompt-A and then prompt-B 200ms later (B before A finished),
 * B is enqueued behind A. When A's `done` event arrives, A
 * resolves and is removed; B starts immediately on the same hook.
 *
 * Sequential FIFO prevents two parallel streams from racing on the
 * same `stream` state slot — which is exactly what caused the
 * "stuck streaming" symptom in the previous implementation. The
 * editor's React tree is now driven by a single async job at a
 * time, and each job is guaranteed to terminate.
 *
 * Concurrency
 * -----------
 * - One running job at a time (serial executor on a microtask)
 * - `submit()` always returns a fresh Promise
 * - If a job is already running, the new one queues
 * - `cancel(jobId)` aborts the SSE fetch AND rejects the job's promise
 *
 * Event stream
 * ------------
 * Each job exposes `on(listener)` so the React hook can drive its
 * per-event state (the streaming progress pill, the chat-thread
 * assistant message, etc.) from the same listener callback it had
 * before. The listener is fired synchronously on every SSE event.
 */
import {
  streamIleGeneration,
  streamIleEdit,
  type IleStreamEvent,
} from './ileApi';

export type StreamJobKind = 'generate' | 'edit';

export interface StreamJobArgs {
  kind: StreamJobKind;
  /** Required when kind === 'edit'. */
  experienceId?: string;
  /** Required when kind === 'generate'. */
  courseId?: string;
  courseVersionId?: string;
  itemId?: string;
  prompt: string;
}

export interface StreamJobResult {
  /** Final accumulated html the SSE stream emitted. */
  html: string;
  /** Experience id the backend assigned (or the existing id, for edits). */
  experienceId: string;
  /** True if the backend truncated at max_tokens. */
  truncated?: boolean;
}

export type StreamJobListener = (event: IleStreamEvent) => void;

interface QueueJob {
  id: number;
  args: StreamJobArgs;
  listeners: Set<StreamJobListener>;
  resolve: (result: StreamJobResult) => void;
  reject: (err: Error) => void;
  /** Abort function for the in-flight fetch (if any). */
  abort: () => void;
}

class IleStreamQueue {
  private nextId = 1;
  private queue: QueueJob[] = [];
  private running: QueueJob | null = null;

  /**
   * Submit a new stream job. Returns a handle whose `promise`
   * resolves with the final html + experienceId on `done`, or
   * rejects on error / cancel / transport failure. The handle's
   * `on(listener)` subscribes to per-event callbacks; subscribe
   * immediately to avoid dropping events between submit and your
   * first await.
   */
  submit(args: StreamJobArgs): StreamJobHandle {
    // Sentinel resolve/reject are replaced synchronously below — we
    // need the Promise in scope to assign into the job.
    let resolve!: (result: StreamJobResult) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<StreamJobResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const job: QueueJob = {
      id: this.nextId++,
      args,
      listeners: new Set(),
      resolve,
      reject,
      abort: () => {
        /* set in runJob once the fetch is open */
      },
    };

    this.queue.push(job);
    this.pump();

    return {
      promise,
      on: (listener) => {
        job.listeners.add(listener);
        return () => {
          job.listeners.delete(listener);
        };
      },
      cancel: () => this.cancel(job.id),
    };
  }

  /** Cancel a queued or running job. */
  cancel(jobId: number): void {
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      this.rejectOnce(job, new DOMException(
        'Stream job cancelled before start',
        'AbortError',
      ));
      return;
    }
    if (this.running?.id === jobId) {
      this.running.abort();
      // The AbortController in the in-flight fetch will throw
      // AbortError inside runJob, which rejects the job's promise.
    }
  }

  /** Cancel everything in flight + queued. */
  cancelAll(): void {
    for (const job of this.queue) {
      this.rejectOnce(
        job,
        new DOMException('Stream job cancelled (cancelAll)', 'AbortError'),
      );
    }
    this.queue.length = 0;
    this.running?.abort();
  }

  /** True if there's an in-flight job or queued work. */
  get busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  /**
   * Drain the queue: if no job is running and there's queued work,
   * dequeue the head and run it. The runner is a microtask so the
   * caller's `submit()` call returns the handle synchronously.
   */
  private pump(): void {
    if (this.running !== null) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    queueMicrotask(() => {
      void this.runJob(job).finally(() => {
        this.running = null;
        this.pump();
      });
    });
  }

  /**
   * Run a single job to completion. ALWAYS settles the job's
   * promise exactly once — that's the whole point of this queue.
   * The watchdog catches the "stream stalls mid-flight" case where
   * the connection is alive but no events arrive; without it the
   * user would see the editor stuck on "Streaming" indefinitely.
   */
  private async runJob(job: QueueJob): Promise<void> {
    const controller = new AbortController();
    let settled = false;

    // Watchdog: if no event for 90s, kill the job.
    const WATCHDOG_MS = 90_000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        controller.abort();
        this.rejectOnce(
          job,
          new Error(
            `Stream stalled (no events for ${WATCHDOG_MS / 1000}s). The provider may have dropped the connection.`,
          ),
        );
        settled = true;
      }, WATCHDOG_MS);
    };

    const fire = (event: IleStreamEvent) => {
      armWatchdog();
      for (const l of job.listeners) {
        try {
          l(event);
        } catch (err) {
          console.error('[ILE][queue] listener threw', err);
        }
      }
      if (event.kind === 'done' || event.kind === 'error') settled = true;
    };

    armWatchdog();

    // Wire cancel() to abort the fetch.
    job.abort = () => {
      controller.abort();
      this.rejectOnce(
        job,
        new DOMException('Stream job cancelled', 'AbortError'),
      );
      settled = true;
    };

    let lastHtml = '';
    let lastExperienceId =
      job.args.kind === 'edit' ? job.args.experienceId ?? '' : '';
    let truncated = false;

    try {
      const onEvent = (ev: IleStreamEvent) => {
        fire(ev);
        switch (ev.kind) {
          case 'html':
            lastHtml += ev.delta;
            break;
          case 'start':
            if (ev.experienceId) lastExperienceId = ev.experienceId;
            break;
          case 'done':
            // `done` carries the canonical final html + experienceId;
            // prefer it over our accumulator in case the server
            // trimmed trailing whitespace or normalized tags.
            lastHtml = ev.html;
            lastExperienceId = ev.experienceId;
            truncated = ev.truncated ?? false;
            break;
          case 'error':
            // Throw to land in the catch below — fire() already
            // forwarded the event to the consumer for their own
            // error UI (toast, etc.).
            throw new Error(ev.message || 'Stream error');
        }
      };

      // Kick off the stream. We deliberately do NOT await a
      // completion promise here — ileApi's streamIle* doesn't
      // return one (they return a cancel-handle instead). Instead,
      // we wait for the `done` event to flip our `settled` flag,
      // and we keep polling until it does. The watchdog kills the
      // job if the flag never flips.
      //
      // The shared `controller.signal` is the trigger both for the
      // queue's cancel() (the bridge below) and the watchdog's
      // 90s idle timeout. Both paths actually abort the underlying
      // fetch now — the previous implementation created a
      // controller without plumbing it through, so cancelling only
      // rejected the promise while the fetch kept running.
      const cancel =
        job.args.kind === 'edit'
          ? streamIleEdit(
              {
                experienceId: job.args.experienceId!,
                prompt: job.args.prompt,
              },
              onEvent,
              { signal: controller.signal },
            )
          : streamIleGeneration(
              {
                prompt: job.args.prompt,
                courseId: job.args.courseId!,
                courseVersionId: job.args.courseVersionId!,
                itemId: job.args.itemId,
              },
              onEvent,
              { signal: controller.signal },
            );

      // Bridge: make job.abort() also call the ileApi cancel handle
      // (in addition to aborting the fetch). The fetch abort path
      // inside ileApi.openIleSse throws AbortError, which surfaces
      // as a rejection in the catch below.
      const prevAbort = job.abort;
      job.abort = () => {
        prevAbort();
        try {
          cancel();
        } catch {
          /* cancel may throw if already closed — ignore */
        }
      };

      // Poll until settled or aborted.
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (settled || controller.signal.aborted) {
            resolve();
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });

      if (controller.signal.aborted) {
        // Watchdog or cancel path. The promise was already rejected
        // in armWatchdog / job.abort — nothing more to do.
        return;
      }

      // Normal completion: resolve with the accumulated payload.
      // Promise resolution is idempotent — if anything above already
      // settled this, the second call is a no-op.
      this.resolveOnce(job, {
        html: lastHtml,
        experienceId: lastExperienceId,
        truncated,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.rejectOnce(job, e);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  /**
   * Safe idempotent resolve — the Promise can only settle once.
   * Subsequent calls are no-ops. Without this guard, a stream
   * could end with two `done` events (or a `done` arriving after
   * a watchdog abort) and call resolve/reject twice.
   */
  private resolveOnce(
    job: QueueJob,
    result: StreamJobResult,
  ): void {
    try {
      job.resolve(result);
    } catch {
      /* already settled */
    }
  }

  private rejectOnce(job: QueueJob, err: Error): void {
    try {
      job.reject(err);
    } catch {
      /* already settled */
    }
  }
}

export interface StreamJobHandle {
  /** Resolves when the SSE `done` event arrives, rejects on cancel/error/transport. */
  promise: Promise<StreamJobResult>;
  /** Subscribe to per-event callbacks (start/progress/html/done/error). */
  on: (listener: StreamJobListener) => () => void;
  /** Cancel this job (queued or running). Rejects the promise with AbortError. */
  cancel: () => void;
}

// Process-wide singleton. We only have one ILE workspace open at a
// time, so a single queue handles all of them. If the queue ever
// needs to be multi-instance, we'd lift it into a React context.
const queue = new IleStreamQueue();

/**
 * Imperative singleton — useful when you need to submit / cancel
 * jobs outside of a React render (e.g. inside a `useEffect` or
 * imperative callback). The hook below is just a thin wrapper
 * around this same instance.
 */
export const streamQueue = queue;

/**
 * React hook — returns the singleton queue wrapped in a stable
 * interface. The hook itself does no work; callers use the returned
 * helpers to submit jobs + await their promises.
 */
export function useIleStreamQueue() {
  return {
    submit: (args: StreamJobArgs): StreamJobHandle => queue.submit(args),
    cancel: (jobId?: number) => {
      if (typeof jobId === 'number') queue.cancel(jobId);
      else queue.cancelAll();
    },
    busy: () => queue.busy,
  };
}

export type { IleStreamEvent } from './ileApi';
