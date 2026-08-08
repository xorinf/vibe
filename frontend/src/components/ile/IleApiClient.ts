/**
 * Dedicated REST client for the Interactive Experience module.
 *
 * Why a class instead of free functions:
 * - Single place to centralize the auth token, base URL, and
 *   timeout policy. The previous free-function API had
 *   `fetchWithTimeout`, `postJson`, `getJson`, `authHeaders`,
 *   etc. scattered across one 1300-line file; callers had to
 *   pass the right options to each one.
 * - A class lets us add per-request `AbortSignal`, typed
 *   `IleApiError` subclasses, and a `cancel()` method that
 *   aborts every in-flight request — used when the workspace
 *   unmounts and we don't want a backgrounded save to keep
 *   the itemsGroup row out of sync.
 * - All HTTP verbs share a single `request<T>()` path so a
 *   future interceptor (auth refresh, metrics, request id)
 *   lands in one place.
 *
 * This class is intentionally NOT a singleton — the workspace
 * constructs a fresh instance per mount and cancels it on
 * unmount. The token + base URL are read from module scope
 * (matching the prior behaviour) so the construction cost is
 * zero.
 */
import { getAuthToken } from './ileApi';

const API_BASE = import.meta.env.VITE_BASE_URL ?? '';

/** Default per-request timeout. 30s covers most interactive
 *  flows. Long-running endpoints (e.g. asset upload) should
 *  pass an explicit `timeoutMs` per call. */
export const DEFAULT_REST_TIMEOUT_MS = 30_000;

/** Statuses for which the client will NOT retry — a 4xx means
 *  the request is malformed in a way that retrying won't fix. */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 409, 410, 422]);

/**
 * Typed error hierarchy so the workspace can render a
 * specific toast per failure mode ("timed out — try again"
 * vs "your session expired — sign in again" vs "the ILE
 * service is down — we'll retry automatically").
 */
export type IleApiErrorKind =
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'server'
  | 'unknown';

export class IleApiError extends Error {
  readonly kind: IleApiErrorKind;
  readonly status: number | null;
  readonly bodyText: string | null;
  readonly url: string;
  readonly retriable: boolean;

  constructor(args: {
    message: string;
    kind: IleApiErrorKind;
    status: number | null;
    bodyText: string | null;
    url: string;
    retriable: boolean;
  }) {
    super(args.message);
    this.name = 'IleApiError';
    this.kind = args.kind;
    this.status = args.status;
    this.bodyText = args.bodyText;
    this.url = args.url;
    this.retriable = args.retriable;
  }
}

/**
 * Per-request options.
 *
 * - `signal`  : caller-supplied AbortSignal. Chained with the
 *               client-level timeout so a caller cancel propagates.
 * - `timeoutMs`: per-request override. Defaults to
 *                DEFAULT_REST_TIMEOUT_MS (30s).
 * - `retries` : how many extra attempts to make on transient
 *               errors. 0 = no retry. Only idempotent methods
 *               (GET/HEAD) get automatic retries; mutating calls
 *               (POST/PUT/DELETE) retry only on network/timeout
 *               and only when the caller explicitly asks.
 * - `retryDelayMs` : base delay between retries. Doubled each
 *                    attempt (exponential backoff), capped at 8s.
 */
export interface IleRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** When true, this call may safely retry on 5xx. Defaults to
   *  `false` (the ILE save endpoint is not idempotent in the
   *  strict sense — see the `Idempotency-Key` header option if
   *  you need to retry a save). */
  idempotent?: boolean;
}

export class IleApiClient {
  /** Per-client abort controller. `client.cancel()` aborts
   *  every in-flight request issued by this instance. Useful
   *  for React useEffect cleanups. */
  private readonly abortController = new AbortController();

  /**
   * Explicitly cancel all in-flight requests for this client.
   * Idempotent — safe to call from React cleanup.
   */
  cancel(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  /**
   * GET helper. Always idempotent: a transient network error or
   * 5xx is safely retried. Caller can pass `retries: 0` to
   * opt out.
   */
  async get<T>(path: string, opts: IleRequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, {
      ...opts,
      idempotent: true,
    });
  }

  /**
   * POST helper. By default NOT retried — the ILE save endpoint
   * is not strictly idempotent. Caller can pass `idempotent: true`
   * for endpoints that are (e.g. publish), or `retries: N` to
   * opt into network/timeout-only retries.
   */
  async post<T>(
    path: string,
    body: unknown,
    opts: IleRequestOptions = {},
  ): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  async put<T>(
    path: string,
    body: unknown,
    opts: IleRequestOptions = {},
  ): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  async patch<T>(
    path: string,
    body: unknown,
    opts: IleRequestOptions = {},
  ): Promise<T> {
    return this.request<T>('PATCH', path, body, opts);
  }

  async delete<T>(path: string, opts: IleRequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }

  /**
   * Lower-level request method. Combines:
   *   - the caller's AbortSignal
   *   - the per-request timeout
   *   - the client-level cancel signal
   *   - the auth token (read fresh on every call so a token
   *     refresh from another tab propagates)
   * into a single fetch + parse + error-classify pipeline.
   *
   * Retry policy: only network / timeout / 5xx errors are
   * retried. 4xx errors surface immediately because the
   * request is structurally wrong and retrying won't help.
   * The retry loop is bounded by the caller's `retries`
   * option; we double the delay each attempt (200ms, 400ms,
   * 800ms, 1.6s, 3.2s, 6.4s, capped at 8s) so a flapping
   * server doesn't get hammered.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: IleRequestOptions,
  ): Promise<T> {
    const maxRetries = Math.max(0, opts.retries ?? (opts.idempotent ? 2 : 0));
    const baseDelay = Math.max(0, opts.retryDelayMs ?? 250);
    const url = `${API_BASE}${path}`;

    let lastError: IleApiError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.singleAttempt<T>(method, url, body, opts);
      } catch (err) {
        if (!(err instanceof IleApiError)) {
          throw err;
        }
        lastError = err;
        // Don't retry cancelled requests — the user did that
        // on purpose and retrying would be a footgun.
        if (err.kind === 'cancelled') {
          throw err;
        }
        // Don't retry 4xx.
        if (err.status !== null && NON_RETRYABLE_STATUS.has(err.status)) {
          throw err;
        }
        // Don't retry non-retriable errors.
        if (!err.retriable) {
          throw err;
        }
        // Last attempt: give up.
        if (attempt === maxRetries) {
          throw err;
        }
        // Exponential backoff with a hard cap at 8s. Sleep is
        // aborted if the client is cancelled mid-wait.
        const delay = Math.min(baseDelay * 2 ** attempt, 8_000);
        try {
          await this.sleep(delay, this.abortController.signal);
        } catch {
          // Sleep itself was cancelled — surface the original
          // error rather than the abort.
          throw err;
        }
      }
    }
    // Unreachable: the loop either returns, throws, or has a
    // final-attempt throw on the line above. Belt and braces.
    throw lastError ?? new Error('IleApiClient.request: unexpected fallthrough');
  }

  private async singleAttempt<T>(
    method: string,
    url: string,
    body: unknown,
    opts: IleRequestOptions,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const composed = composeSignals(
      this.abortController.signal,
      timeoutSignal,
      opts.signal,
    );

    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaderFromToken(),
      },
      signal: composed.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response | undefined;
    try {
      try {
        res = await fetch(url, init);
      } catch (err) {
        // Distinguish timeout, cancellation, and bare network
        // failures so the workspace's error toast can be specific.
        if (err instanceof DOMException) {
          if (err.name === 'AbortError') {
            // Cancel could have come from the timeout, the
            // client, or the caller. Use the most-specific
            // signal that aborted to figure out which.
            if (timeoutSignal.aborted) {
              throw new IleApiError({
                message: `Request timed out after ${timeoutMs}ms: ${url}`,
                kind: 'timeout',
                status: null,
                bodyText: null,
                url,
                retriable: true,
              });
            }
            if (this.abortController.signal.aborted) {
              throw new IleApiError({
                message: `Request cancelled: ${url}`,
                kind: 'cancelled',
                status: null,
                bodyText: null,
                url,
                retriable: false,
              });
            }
            throw new IleApiError({
              message: `Request cancelled by caller: ${url}`,
              kind: 'cancelled',
              status: null,
              bodyText: null,
              url,
              retriable: false,
            });
          }
        }
        throw new IleApiError({
          message: `Network error: ${
            err instanceof Error ? err.message : String(err)
          } (${url})`,
          kind: 'network',
          status: null,
          bodyText: null,
          url,
          retriable: true,
        });
      }

      try {
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw classifyHttpError(res.status, bodyText, url);
        }
        // Some endpoints return 204 with no body.
        if (res.status === 204) {
          return undefined as T;
        }
        return (await res.json()) as T;
      } finally {
        // Always detach the per-input abort listeners — without
        // this, the closure stays attached to the input signals
        // (typically the client-level AbortController, which
        // lives for the lifetime of the page) until the input
        // signal itself aborts. Small leak per request, but real
        // over a long-lived page.
        composed.dispose();
      }
    } finally {
      // The outer finally handles the fetch() path — `composed`
      // might still be live (and its inner listeners might still
      // be attached) if the throw happens before the inner
      // try/finally runs. dispose() is idempotent so calling it
      // twice is safe.
      if (res === undefined) {
        composed.dispose();
      }
    }
  }

  /**
   * Sleep that aborts when the given signal aborts. We don't
   * use `setTimeout` directly because there's no clean way to
   * cancel a pending sleep from a React useEffect cleanup —
   * dangling timers would prevent the page from unmounting
   * promptly.
   */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function authHeaderFromToken(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Combine multiple AbortSignals into one. The composed signal
 * aborts as soon as ANY input signal aborts. A pre-aborted
 * input causes immediate abort.
 *
 * Returns `{ signal, dispose }` so callers can clean up the
 * per-input abort listeners when the request finishes (success
 * or error) — without `dispose`, the inner listeners stay
 * attached to the input signals for the rest of the page
 * lifetime, leaking closures. `dispose` is idempotent.
 *
 * Avoids `AbortSignal.any()` because the latter's error
 * propagation is browser-version-dependent and our existing
 * tests still hit Safari versions that get it wrong.
 */
function composeSignals(
  ...signals: (AbortSignal | undefined)[]
): { signal: AbortSignal; dispose: () => void } {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) {
    // No signals to compose — return a fresh signal that never
    // aborts. dispose is a no-op.
    const controller = new AbortController();
    return {
      signal: controller.signal,
      dispose: () => {
        /* nothing to clean up */
      },
    };
  }
  if (live.length === 1) {
    return {
      signal: live[0],
      dispose: () => {
        /* no extra listeners to clean up */
      },
    };
  }
  const controller = new AbortController();
  // Track the listener fns so dispose() can detach them.
  // Without this, every fetch leaves a closure attached to
  // the input signal — a small but real memory leak over a
  // long-lived page.
  const onAbort = () => controller.abort();
  for (const sig of live) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const sig of live) {
        sig.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * Map an HTTP error response to a typed `IleApiError`. The
 * `kind` is what the workspace's error toast reads to decide
 * whether to retry, sign the user out, or surface a
 * validation message.
 */
function classifyHttpError(
  status: number,
  bodyText: string,
  url: string,
): IleApiError {
  const retriable = status >= 500 || status === 408 || status === 429;
  let kind: IleApiErrorKind = 'unknown';
  if (status === 401) kind = 'auth';
  else if (status === 403) kind = 'forbidden';
  else if (status === 404) kind = 'not_found';
  else if (status === 422 || status === 400) kind = 'validation';
  else if (status >= 500) kind = 'server';
  return new IleApiError({
    message: `API ${url} failed: ${status} ${bodyText || '(no body)'}`.slice(0, 500),
    kind,
    status,
    bodyText,
    url,
    retriable,
  });
}
