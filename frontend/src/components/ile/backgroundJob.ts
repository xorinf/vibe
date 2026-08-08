/**
 * Long-running background job abstraction.
 *
 * Why a class — the ILE module has two genuinely long-running
 * operations (the SSE AI generation stream and the XHR asset
 * upload) that need a uniform state model:
 *
 *   idle  → running → success | error | cancelled
 *
 * The class abstracts the lifecycle so:
 *   - the React layer just renders `job.status` and `job.progress`
 *     without thinking about the underlying transport (SSE,
 *     XHR, future WebSocket);
 *   - cleanup is centralized — `job.cancel()` aborts whichever
 *     transport owns the request, and the worker's "fallback"
 *     cleanup (e.g. revoking an object URL) runs alongside;
 *   - the workspace unmounts cleanly: it can call
 *     `client.cancel()` on every active job without knowing
 *     what each one is doing internally;
 *   - errors propagate as `IleApiError` so the existing
 *     kind-specific toasts work without change.
 *
 * Two concrete workers are exported (`runSseJob`,
 * `runXhrUploadJob`) — these are the fallbacks the user asked
 * for. The class is generic; pages can also write their own
 * worker for non-network long work (e.g. a `setTimeout`-driven
 * retry loop).
 */
import { IleApiError } from './IleApiClient';

export type BackgroundJobStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

export interface BackgroundJob<T> {
  /** Current lifecycle state. */
  status: BackgroundJobStatus;
  /** Most recent value emitted by the worker, if any. */
  data: T | null;
  /** Most recent error thrown by the worker, if any. */
  error: IleApiError | null;
  /**
   * 0–100. The worker is responsible for emitting progress
   * via the `onProgress` callback. Workers that don't report
   * progress keep this at 0.
   */
  progress: number;
  /**
   * Cancel the underlying work. Idempotent — safe to call from
   * a React useEffect cleanup.
   */
  cancel(): void;
  /**
   * Subscribe to status changes. Returns the unsubscribe fn.
   * React pages use a `useSyncExternalStore` shim to render
   * `job.status` without re-rendering on every progress tick.
   */
  subscribe(listener: (job: BackgroundJob<T>) => void): () => void;
}

export type Worker<T> = (
  ctx: WorkerContext<T>,
  signal: AbortSignal,
) => Promise<T>;

export interface WorkerContext<T> {
  /** Emit a progress update. No-op if the job is already
   *  cancelled. */
  onProgress(percent: number): void;
  /** Emit an intermediate data value (e.g. a partial
   *  generation). No-op if the job is already cancelled. */
  onData(data: T): void;
  /** Underlying AbortSignal — workers can wire this into
   *  fetch / EventSource so a `job.cancel()` propagates. */
  signal: AbortSignal;
}

/**
 * Run a worker as a managed background job. Returns the job
 * object the caller uses to subscribe to status / cancel /
 * read the result.
 *
 * Lifecycle:
 *   1. status → 'running'  (immediately, before the worker)
 *   2. worker(...) resolves → status → 'success' with data
 *   3. worker(...) throws a non-`AbortError` → status → 'error'
 *      with the error mapped to an `IleApiError`
 *   4. worker(...) throws an `AbortError` OR ctx is aborted
 *      mid-flight → status → 'cancelled'
 */
export function createBackgroundJob<T>(
  worker: Worker<T>,
): BackgroundJob<T> {
  const listeners = new Set<(job: BackgroundJob<T>) => void>();
  const state: BackgroundJob<T> = {
    status: 'idle',
    data: null,
    error: null,
    progress: 0,
    cancel: () => {
      // Idempotent — repeated calls are no-ops.
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const controller = new AbortController();
  state.cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (state.status === 'running' || state.status === 'idle') {
      // Synchronously flip to cancelled so subscribers see
      // it the same tick the cancel was requested.
      state.status = 'cancelled';
      notify();
    }
  };

  function notify() {
    for (const l of listeners) {
      try {
        l(state);
      } catch {
        // listener errors must not stop the others.
      }
    }
  }

  // Start the worker. Errors here are caught and mapped to
  // the typed IleApiError hierarchy so the rest of the
  // app can render kind-specific toasts.
  (async () => {
    state.status = 'running';
    notify();
    try {
      const ctx: WorkerContext<T> = {
        signal: controller.signal,
        onProgress(percent) {
          if (controller.signal.aborted) return;
          state.progress = Math.max(0, Math.min(100, percent));
          notify();
        },
        onData(data) {
          if (controller.signal.aborted) return;
          state.data = data;
          notify();
        },
      };
      const result = await worker(ctx, controller.signal);
      if (controller.signal.aborted) {
        state.status = 'cancelled';
      } else {
        state.status = 'success';
        state.data = result;
      }
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        state.status = 'cancelled';
      } else {
        state.status = 'error';
        // Map any thrown error to IleApiError so callers
        // get a single, predictable shape.
        state.error = toIleApiError(err);
      }
    } finally {
      notify();
    }
  })();

  return state;
}

/**
 * Map any thrown value to an `IleApiError`. Preserves an
 * existing `IleApiError`; coerces a plain `Error` to its
 * `message`; falls back to a generic `unknown` shape for
 * non-Error throws (rare; happens with bad polyfills).
 */
function toIleApiError(err: any): IleApiError {
  if (err instanceof IleApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IleApiError({
    message,
    kind: 'unknown',
    status: null,
    bodyText: null,
    url: '',
    retriable: true,
  });
}

/**
 * Convenience: run an SSE-bound worker. The worker receives
 * an `EventSource` whose lifecycle is owned by the job.
 * When the job is cancelled, the EventSource is closed.
 *
 * The worker is responsible for parsing events; the helpers
 * in `./ileSse` (or the existing `bindIleStream`) can be used
 * here.
 */
export function runSseJob<T>(
  openStream: (signal: AbortSignal) => {
    onEvent: (cb: (event: MessageEvent) => void) => () => void;
    close: () => void;
  },
  parse: (event: MessageEvent) => T | null,
): BackgroundJob<T | null> {
  // `signal` is the job's AbortSignal; we ignore the unused
  // `ctx` arg here because the worker receives its own
  // signal via the openStream call.
  return createBackgroundJob<T | null>((_ctx, signal) => {
    return new Promise<T | null>((resolve, reject) => {
      let resolved = false;
      const handle = openStream(signal);
      const off = handle.onEvent((raw) => {
        if (resolved) return;
        const parsed = parse(raw);
        if (parsed !== null) {
          // Heuristic: the first parseable event we see is
          // the "final" result for this worker. A more
          // sophisticated worker would use ctx.onData() to
          // surface partial updates.
          resolved = true;
          off();
          handle.close();
          resolve(parsed);
        }
      });
      signal.addEventListener(
        'abort',
        () => {
          if (resolved) return;
          off();
          handle.close();
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  });
}

/**
 * Convenience: run an XHR upload as a managed job. The
 * worker receives an XHR object wired to the job's abort
 * signal. When the job is cancelled, xhr.abort() fires and
 * the XHR's `onabort` is mapped to a typed cancellation.
 *
 * This is the fallback the user asked for: any page that
 * previously had a raw XHR can now route it through this
 * helper and get status / progress / cancel for free.
 */
export function runXhrUploadJob<T>(args: {
  method: 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  /** XHR body. `FormData | Blob | string | ArrayBuffer` —
   *  the standard XHR body types. Stream/ReadableStream is
   *  intentionally unsupported (XHR doesn't accept it). */
  body: FormData | Blob | string | ArrayBuffer | URLSearchParams;
  timeoutMs?: number;
  parse: (text: string) => T;
}): BackgroundJob<T> {
  return createBackgroundJob<T>((ctx, signal) => {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(args.method, args.url);
      if (args.headers) {
        for (const [k, v] of Object.entries(args.headers)) {
          xhr.setRequestHeader(k, v);
        }
      }
      xhr.timeout = args.timeoutMs ?? 5 * 60 * 1000;
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          ctx.onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(args.parse(xhr.responseText));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(
            new IleApiError({
              message: `XHR ${args.method} ${args.url} failed: ${xhr.status} ${xhr.statusText}`,
              kind: xhr.status === 401 ? 'auth' : xhr.status >= 500 ? 'server' : 'unknown',
              status: xhr.status,
              bodyText: xhr.responseText.slice(0, 500),
              url: args.url,
              retriable: xhr.status >= 500 || xhr.status === 408 || xhr.status === 429,
            }),
          );
        }
      };
      xhr.onerror = () =>
        reject(
          new IleApiError({
            message: `XHR network error: ${args.url}`,
            kind: 'network',
            status: null,
            bodyText: null,
            url: args.url,
            retriable: true,
          }),
        );
      xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
      xhr.ontimeout = () =>
        reject(
          new IleApiError({
            message: `XHR timed out after ${args.timeoutMs ?? 300_000}ms: ${args.url}`,
            kind: 'timeout',
            status: null,
            bodyText: null,
            url: args.url,
            retriable: true,
          }),
        );
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(args.body);
    });
  });
}
