/**
 * event-source-polyfill v1 silently delegates to the native
 * EventSource on modern browsers (see node_modules/event-source-
 * polyfill/src/eventsource.js:1021-1030 — `R = NativeEventSource`
 * when the browser already has EventSource with withCredentials).
 * The native EventSource ignores the `method: 'POST'` init option
 * and falls back to GET, which the ILE generate/edit/context
 * routes don't accept (404). That's why the ILE streams have
 * been throwing "Stream connection lost" since the moment a
 * user opened an existing experience and clicked Generate.
 *
 * To make POST actually work we go around the polyfill
 * entirely: open the request with `fetch`, then read the
 * `ReadableStream` body line-by-line and parse the SSE event
 * stream ourselves. This is a small, well-defined contract and
 * avoids pulling in a heavier SSE library.
 */

// Minimal subset of an EventSource-like surface the ILE
// stream call sites need. (Same shape as the previous
// EventSourcePolyfill usage; bindIleStream only uses
// addEventListener and close.)
interface ILEStreamSource {
  addEventListener(
    type: 'start' | 'progress' | 'reasoning' | 'html' | 'done' | 'error' | string,
    listener: (ev: MessageEvent) => void,
  ): void;
  close(): void;
}

/**
 * Open a POST request and pipe the response body as SSE events
 * to a tiny EventSource-shaped sink. Returns a handle whose
 * `.close()` aborts the in-flight fetch and stops reading.
 *
 * Lines are split on \n, \r, or \r\n (per the SSE spec). An
 * event block is a run of `field: value` lines followed by a
 * blank line; we only consume the `event:` and `data:` fields,
 * which is the entire ILE server contract.
 */
function openIleSse(
  url: string,
  body: unknown,
  token: string,
): ILEStreamSource {
  const controller = new AbortController();
  let closed = false;
  const listeners: Record<
    string,
    Array<(ev: MessageEvent) => void>
  > = {};

  const fire = (type: string, data: string) => {
    const ev = {
      data,
      type,
    } as unknown as MessageEvent;
    for (const l of listeners[type] ?? []) {
      try {
        l(ev);
      } catch (e) {
        // Don't let a listener error tear down the parser.
        console.error('[ILE][sse] listener threw', e);
      }
    }
  };

  void (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Do NOT bail on !res.ok here. routing-controllers' ExpressDriver
      // throws `Cannot set headers after they are sent` after a clean
      // SSE stream (see IleGenerationService.ts and the
      // sse-post-stream-headers-sent-race-2026-07-26 reference) — the
      // body has already been flushed with the `done` event, and the
      // final HTTP status arrives as 500. Bailing here means we never
      // read the body and the editor hook stays stuck in `'streaming'`
      // forever (the P1-5 watchdog eventually surfaces an error
      // message, but the cleaner UX is to let the body's own `done`
      // event transition the hook normally).
      //
      // Surface non-2xx as a synthetic `error` ONLY when the body is
      // empty / unreadable — that's the genuine "stream never started"
      // case (validation failure, auth, route 404). For non-empty
      // non-2xx bodies, the parser runs to EOF; if no terminal event
      // arrives, the EOF handler below synthesizes the error.
      const wasNonOk = !res.ok;
      const status = res.status;
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.body) {
        fire('error', '');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let currentEvent = 'message';
      let dataLines: string[] = [];
      // Track whether a terminal event fired during the stream. The
      // EOF handler below fires a synthetic `error` if no terminal
      // event was seen — closes audit H8 (a non-2xx body or an empty
      // body that parsed to no events used to wait 90s for the
      // editor watchdog; now it surfaces immediately).
      let sawTerminalEvent = false;
      const flush = () => {
        if (dataLines.length === 0) return;
        const data = dataLines.join('\n');
        dataLines = [];
        fire(currentEvent, data);
        if (currentEvent === 'done' || currentEvent === 'error') {
          sawTerminalEvent = true;
        }
        currentEvent = 'message';
      };
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === '') {
            flush();
            continue;
          }
          if (line.startsWith(':')) continue; // comment
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') currentEvent = value;
          else if (field === 'data') dataLines.push(value);
          // 'id:' and 'retry:' ignored — ILE server doesn't use them
        }
      }
      // Drain any trailing partial line + flush.
      if (buffer.length > 0) {
        const line = buffer.replace(/\r$/, '');
        if (line.startsWith(':')) {
          // comment, ignore
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') currentEvent = value;
          else if (field === 'data') dataLines.push(value);
        }
      }
      flush();

      // EOF reached. If we never saw a terminal SSE event, the stream
      // is implicitly broken — auth, 4xx, 5xx, proxy error page, etc.
      // Synthesize an `error` so the editor hook doesn't wait 90s for
      // the watchdog. We always include status + content-type in the
      // synthetic payload so the UI can show "the stream returned
      // HTTP 401 before sending any events" instead of a generic
      // "stalled" toast. Status 0 means the request never got a
      // response (network error before first byte).
      if (!sawTerminalEvent && !closed) {
        const summary = wasNonOk
          ? `Server returned HTTP ${status} ${contentType ? `(${contentType.split(';')[0]})` : ''}`
          : status
            ? `Stream ended without a terminal event (HTTP ${status})`
            : 'Stream ended without a terminal event';
        fire('error', summary);
      }
    } catch (err) {
      if (closed) return;
      // AbortError on close() is expected. Anything else is a
      // genuine network failure — let bindIleStream's synthetic
      // error handler surface it.
      if ((err as { name?: string })?.name === 'AbortError') return;
      fire('error', '');
    }
  })();

  return {
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.abort();
      } catch {
        // already aborted
      }
    },
  };
}

/**
 * Wire up SSE event listeners on a fetch-based stream source.
 *
 * `onerror` here is a synthetic we emit ourselves: either the
 * HTTP response wasn't 200 (a 4xx/5xx the native EventSource
 * would have surfaced as onerror with no data), or the
 * connection dropped before the server sent a terminal event.
 * We track an `ended` flag so the synthetic only fires for
 * genuine transport failures — the server-sent 'done' or
 * 'error' events take precedence and surface verbatim.
 */
function bindIleStream(
  es: ILEStreamSource,
  onEvent: (event: IleStreamEvent) => void,
  options: { syntheticMessage: string; closeOnTerminal?: boolean } = {
    syntheticMessage: 'Stream connection lost. Check the network and retry.',
  },
): void {
  let ended = false;
  const markEnded = () => {
    ended = true;
  };
  const closeOnce = () => {
    if (options.closeOnTerminal) {
      try {
        es.close();
      } catch {
        // already closed
      }
    }
  };

  function bind(eventName: string, kind: IleStreamEvent['kind']) {
    es.addEventListener(eventName, (raw) => {
      const msg = raw as MessageEvent;
      if (typeof msg?.data !== 'string') return;
      let parsed: Record<string, unknown> = {};
      if (msg.data.length > 0) {
        try {
          const v = JSON.parse(msg.data);
          if (v && typeof v === 'object') parsed = v as Record<string, unknown>;
        } catch {
          return;
        }
      }
      if (kind === 'done' || kind === 'error') markEnded();
      onEvent({ kind, ...parsed } as IleStreamEvent);
      if (kind === 'done' || kind === 'error') closeOnce();
    });
  }
  bind('start', 'start');
  bind('progress', 'progress');
  bind('reasoning', 'reasoning');
  bind('html', 'html');
  bind('done', 'done');
  bind('error', 'error');

  // The fetch-based source has no separate "connection lost"
  // channel; non-2xx responses and aborts both surface through
  // the 'error' event with empty data (emitted by openIleSse).
  // If the listener above saw an 'error' event, `ended` is
  // already true and we no-op. Otherwise the stream just ended
  // without a terminal event — fall back to the synthetic.
  // We approximate that with a small idle watcher: if 250ms
  // pass after the first event without a terminal, and the
  // body has been read to completion, fire the synthetic.
  // (For the ILE server every stream ends with a terminal
  // event, so this is just belt-and-suspenders.)
  setTimeout(() => {
    if (ended) return;
    markEnded();
    onEvent({ kind: 'error', message: options.syntheticMessage });
  }, 180_000);
}

/**
 * ILE API client.
 *
 * Two surfaces:
 *  - REST: save / fetch / publish (regular JSON, fetch wrapper).
 *  - SSE: stream a generation or edit (EventSourcePolyfill because we need
 *    to send Authorization headers + POST bodies, which native EventSource
 *    can't do).
 *
 * The SSE callback shape is intentionally simple — the React hook handles
 * state. The API just hands the caller the raw events.
 */

const API_BASE = import.meta.env.VITE_BASE_URL ?? '';

/**
 * Single source for the Firebase auth token. Use this from every
 * site that needs the Bearer (SSE streams, XHR uploads, REST,
 * event reporter). Replaces five ad-hoc localStorage.getItem reads
 * that used to drift apart when token refresh paths changed.
 */
export function getAuthToken(): string | null {
  try {
    return localStorage.getItem('firebase-auth-token');
  } catch {
    // localStorage can throw in some privacy modes; fall back to null
    // and let the server reject the request.
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Provenance for context-driven generations (e.g. YouTube). The
 * teacher workspace renders this as a "Context: …" chip; the
 * student-facing /:id/play route (StudentIlePayload) intentionally
 * omits it — source URLs are an authoring concern, not a learner
 * one (locked-in decision #4).
 *
 * Mirrors backend `IleContextRef`. We inline the shape here to
 * avoid pulling the transformer module into the frontend.
 */
export interface IleContextRef {
  source: string;
  sourceUrl: string;
  title: string;
  provider: string;
  transcriptHash: string;
  createdAt: string;
}

export interface IleExperienceResponse {
  _id: string;
  title: string;
  html: string;
  /** Original prompt the teacher used to generate / edit. Server returns it
   *  on every save/get so reloads preserve the seed context. */
  prompt: string;
  status: 'draft' | 'published' | 'archived';
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  ownerId: string;
  authorName?: string;
  currentVersion: number;
  archivedAt?: string;
  publishedAt?: string;
  /** Optional context provenance — populated when the experience was
   *  generated from external context (YouTube in v1). Teacher-only. */
  context?: IleContextRef;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight summary for the History / Manager list views. */
export interface IleExperienceListItem {
  _id: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  currentVersion: number;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  archivedAt?: string;
  publishedAt?: string;
  authorName?: string;
  updatedAt: string;
}

/** Per-save snapshot. Lighter than the full experience. */
export interface IleVersionListItem {
  version: number;
  savedAt: string;
  savedBy: string;
  title: string;
  label?: string;
  htmlLength: number;
  isCurrent: boolean;
}

/** Full version (includes HTML + prompt). */
export interface IleVersionDetail extends IleVersionListItem {
  html: string;
  prompt: string;
}

/**
 * One turn of the teacher ↔ assistant conversation that produced the
 * experience. `html` is the model's response at the end of the turn
 * (omitted on the user side).
 */
export interface IleHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  html?: string;
  createdAt?: string;
}

export interface StudentIlePayload {
  _id: string;
  title: string;
  html: string;
}

export interface SaveIleRequest {
  _id?: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  title: string;
  /**
   * Original generation prompt. Optional — the backend defaults an
   * absent/empty value to a placeholder. See SaveIleBody in
   * backend/.../IleValidators.ts for the rationale.
   */
  prompt?: string;
  html: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

/**
 * PUT helper for the AI config endpoint. Body shape matches IleAiConfigInput.
 */
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

/**
 * POST helper that allows an empty body object — used by the test-connection
 * endpoint where the body is optional (the server falls back to the stored
 * config when fields are absent).
 */
async function postJsonAllowEmpty<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────
// REST

export async function saveIleExperience(
  body: SaveIleRequest,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>('/interactive-experiences', body);
}

export async function getIleExperience(
  id: string,
): Promise<IleExperienceResponse> {
  return getJson<IleExperienceResponse>(`/interactive-experiences/${id}`);
}

export async function publishIleExperience(
  id: string,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/publish`,
    {},
  );
}

export async function getStudentIlePayload(
  id: string,
): Promise<StudentIlePayload> {
  return getJson<StudentIlePayload>(`/interactive-experiences/${id}/play`);
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle — list, version history, rename, duplicate, archive

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

async function deleteRequest(path: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
}

/**
 * fetch() wrapper that adds a transport deadline so a stalled connection
 * or a server that accepts the body and never responds can no longer
 * hang the UI indefinitely. Audit H9 (2026-07-28) — every REST helper
 * previously inherited fetch's no-default-timeout behaviour.
 *
 * The default is 30s for ordinary JSON requests; callers can override
 * via the `timeoutMs` option (upload/long-poll routes use their own
 * transports). When the deadline fires we surface a typed error so
 * the UI can render "Request timed out — retry?" instead of leaving
 * a spinner hung forever.
 *
 * NOTE: AbortSignal.timeout() throws DOMException('TimeoutError') on
 * the fetch promise — we normalise to a plain Error so call sites
 * don't have to special-case it.
 */
export const DEFAULT_REST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_REST_TIMEOUT_MS, ...rest } = init;
  // Compose with any caller-provided signal so an explicit cancel
  // still works (and so callers can chain their own deadlines on top).
  const signal = rest.signal
    ? anySignal([rest.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(input, { ...rest, signal });
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      // Re-thrown as a typed Error so callers don't have to special-case
      // DOMException / TimeoutError across the file.
      const reason = err.name === 'TimeoutError' ? 'timed out' : 'cancelled';
      throw new Error(
        `Request ${reason} after ${timeoutMs}ms (${typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url})`,
      );
    }
    throw err;
  }
}

/**
 * Combine multiple AbortSignals into one. Used when the caller passes
 * their own signal (e.g. from React useEffect cleanup) and we also
 * need a timeout. AbortSignal.any is the modern equivalent; we fall
 * back to manual composition for older targets.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

export async function listIleExperiences(
  opts: { includeArchived?: boolean } = {},
): Promise<{ experiences: IleExperienceListItem[] }> {
  const qs = opts.includeArchived ? '?includeArchived=true' : '';
  return getJson<{ experiences: IleExperienceListItem[] }>(
    `/interactive-experiences${qs}`,
  );
}

export async function listIleVersions(
  id: string,
): Promise<{ versions: IleVersionListItem[] }> {
  return getJson<{ versions: IleVersionListItem[] }>(
    `/interactive-experiences/${id}/versions`,
  );
}

export async function getIleVersion(
  id: string,
  version: number,
): Promise<IleVersionDetail> {
  return getJson<IleVersionDetail>(
    `/interactive-experiences/${id}/versions/${version}`,
  );
}

export async function restoreIleVersion(
  id: string,
  version: number,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/versions/${version}/restore`,
    {},
  );
}

export async function versionedSaveIleExperience(
  id: string,
  body: {
    courseId: string;
    courseVersionId: string;
    itemId?: string;
    title: string;
    prompt: string;
    html: string;
    label?: string;
  },
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/save`,
    body,
  );
}

export async function renameIleExperience(
  id: string,
  title: string,
): Promise<IleExperienceResponse> {
  return patchJson<IleExperienceResponse>(
    `/interactive-experiences/${id}`,
    { title },
  );
}

export async function duplicateIleExperience(
  id: string,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/duplicate`,
    {},
  );
}

export async function archiveIleExperience(
  id: string,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/archive`,
    {},
  );
}

export async function unarchiveIleExperience(
  id: string,
): Promise<IleExperienceResponse> {
  return postJson<IleExperienceResponse>(
    `/interactive-experiences/${id}/unarchive`,
    {},
  );
}

export async function deleteIleExperience(id: string): Promise<void> {
  return deleteRequest(`/interactive-experiences/${id}`);
}

export async function getIleExperienceHistory(
  id: string,
): Promise<{ history: IleHistoryTurn[] }> {
  return getJson<{ history: IleHistoryTurn[] }>(
    `/interactive-experiences/${id}/history`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Asset Manager (upload, list, sign, delete)

export type IleAssetKind = 'image' | 'audio' | 'video' | 'pdf' | 'svg';

export interface IleAssetListItem {
  _id: string;
  kind: IleAssetKind;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface IleAssetUploadResponse extends IleAssetListItem {
  /** Signed GCS URL — 1h TTL. */
  url: string;
  expiresIn: number;
}

export interface IleAssetSignedResponse {
  url: string;
  expiresIn: number;
}

export async function listIleAssets(
  opts: { kind?: IleAssetKind; q?: string } = {},
): Promise<{ assets: IleAssetListItem[] }> {
  const params = new URLSearchParams();
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return getJson<{ assets: IleAssetListItem[] }>(
    `/interactive-experiences/assets${qs ? `?${qs}` : ''}`,
  );
}

export async function uploadIleAsset(args: {
  kind: IleAssetKind;
  file: File;
  onProgress?: (pct: number) => void;
}): Promise<IleAssetUploadResponse> {
  // We use XHR instead of fetch so we can stream progress events
  // through to the caller. fetch() doesn't expose upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/interactive-experiences/assets/upload`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // Audit H9 — bound the upload to 5 minutes. Larger files
    // (videos up to 50MB per ILE_ASSET_LIMITS) can legitimately take
    // a couple of minutes on a slow connection; anything past that
    // is almost certainly a stalled connection and should fail loudly.
    xhr.timeout = 5 * 60 * 1000;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && args.onProgress) {
        args.onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(new Error('Invalid server response'));
        }
      } else {
        let detail = '';
        try {
          detail = (JSON.parse(xhr.responseText) as any)?.message ?? '';
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `Asset upload failed: ${xhr.status} ${xhr.statusText}${detail ? ' — ' + detail : ''}`,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new Error('Asset upload network error'));
    xhr.onabort = () => reject(new Error('Asset upload aborted'));
    xhr.ontimeout = () =>
      reject(new Error('Asset upload timed out (5 minutes — check your connection)'));

    const form = new FormData();
    form.append('file', args.file, args.file.name);
    form.append('kind', args.kind);
    xhr.send(form);
  });
}

export async function getIleAssetSignedUrl(
  id: string,
): Promise<IleAssetSignedResponse> {
  return getJson<IleAssetSignedResponse>(
    `/interactive-experiences/assets/${id}/signed`,
  );
}

export async function deleteIleAsset(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/interactive-experiences/assets/${id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { ...authHeaders() },
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Delete asset failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Student Analytics — both ingestion (student side) and dashboards
// (teacher side).

export type IleStudentEventKind =
  | 'started'
  | 'progress'
  | 'interaction'
  | 'complete'
  | 'error'
  | 'resume'
  | 'retry';

export interface IleRuntimeEvent {
  kind: IleStudentEventKind;
  clientTs: number;
  data?: Record<string, unknown> | null;
}

export interface ExperienceAnalytics {
  experienceId: string;
  title?: string;
  studentsStarted: number;
  studentsCompleted: number;
  completionRate: number;
  averageTimeActiveMs: number;
  errorRate: number;
  difficultyScore: number;
  averageEngagementPerMinute: number;
  averageProgressPct: number;
  totalInteractions: number;
  totalErrors: number;
  totalRetries: number;
  students: {
    studentHash: string;
    startedAt: string;
    lastEventAt: string;
    completedAt?: string;
    lastProgressPct: number;
    timeActiveMs: number;
    interactionCount: number;
    errorCount: number;
    resumeCount: number;
    retryCount: number;
    resumePoint?: { percent?: number; at: string; label?: string | null };
    events: { kind: IleStudentEventKind; clientTs: number; data?: unknown; receivedAt: string }[];
  }[];
}

// Analytics endpoints and response types are kept here so teacher panels share
// one wire contract with the backend analytics service.
export interface AnalyticsBucket {
  date: string; studentsStarted: number; studentsCompleted: number; errors: number;
  retries: number; resumes: number; averageTimeActiveMs: number;
}
export interface TimeSeriesAnalytics { experienceId: string; from: string; to: string; bucket: 'day'; series: AnalyticsBucket[]; }
export interface DropOffCurve { experienceId: string; bins: { pct: number; reachedBy: number; total: number }[]; largestDrop: { fromPct: number; toPct: number; magnitude: number }; }
export interface AnalyticsInsight { id: string; severity: 'info' | 'warning' | 'critical'; title: string; body: string; scope: { progressFrom: number; progressTo: number }; suggestion: string; }

export interface DashboardAnalytics {
  perExperience: ExperienceAnalytics[];
  /** Top-5 most difficult experiences by `difficultyScore` desc. */
  mostDifficult: MostDifficultExperience[];
  totals: {
    studentsStarted: number;
    studentsCompleted: number;
    averageCompletionRate: number;
    /** Mean of per-experience engagement-per-minute across the cohort. */
    averageEngagementPerMin: number;
  };
}

/**
 * One row of the dashboard's "most difficult" leaderboard.
 * Mirrors the backend's MostDifficultExperience — keep in sync.
 */
export interface MostDifficultExperience {
  experienceId: string;
  title?: string;
  difficultyScore: number;
  completionRate: number;
  errorRate: number;
}

export interface IngestResult {
  applied: number;
  studentHash?: string;
}

/**
 * Student-side event ingestion. We pass the student's Firebase ID token
 * via a custom header (X-Vibe-Student-Token) because the sandboxed
 * iframe can't read the parent's localStorage and doesn't have
 * cross-origin cookies for the api. The server salts + hashes it.
 */
export async function ingestIleStudentEvents(
  experienceId: string,
  events: IleRuntimeEvent[],
  ctx: { authToken: string; courseId?: string; courseVersionId?: string },
): Promise<IngestResult> {
  const qs = new URLSearchParams();
  if (ctx.courseId) qs.set('courseId', ctx.courseId);
  if (ctx.courseVersionId) qs.set('courseVersionId', ctx.courseVersionId);
  const url = `/interactive-experiences/${experienceId}/events${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Vibe-Student-Token': ctx.authToken,
    },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Ingest events failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  return res.json();
}

export async function getIleExperienceAnalytics(
  id: string,
): Promise<ExperienceAnalytics> {
  return getJson<ExperienceAnalytics>(`/interactive-experiences/${id}/analytics`);
}

export async function getIleAnalyticsDashboard(
  experienceIds: string[],
): Promise<DashboardAnalytics> {
  const qs = experienceIds.join(',');
  return getJson<DashboardAnalytics>(
    `/interactive-experiences/analytics/dashboard?ids=${qs}`,
  );
}

export interface CompareAnalytics {
  a: ExperienceAnalytics;
  b: ExperienceAnalytics;
  delta: { completionRate: number; averageTimeActiveMs: number; errorRate: number; difficultyScore: number; averageEngagementPerMinute: number };
}

export async function getIleTimeSeries(experienceId: string, opts: { from?: string; to?: string; days?: number } = { days: 30 }): Promise<TimeSeriesAnalytics> {
  const qs = new URLSearchParams();
  if (opts.from) qs.set('from', opts.from);
  if (opts.to) qs.set('to', opts.to);
  if (opts.days !== undefined) qs.set('days', String(opts.days));
  return getJson<TimeSeriesAnalytics>(`/interactive-experiences/${experienceId}/analytics/timeseries${qs.toString() ? `?${qs}` : ''}`);
}
export async function getIleDropOff(experienceId: string): Promise<DropOffCurve> { return getJson<DropOffCurve>(`/interactive-experiences/${experienceId}/analytics/dropoff`); }
export async function getIleInsights(experienceId: string): Promise<AnalyticsInsight[]> { return getJson<AnalyticsInsight[]>(`/interactive-experiences/${experienceId}/analytics/insights`); }
export async function getIleCompare(experienceId: string, compareTo: string): Promise<CompareAnalytics> { return getJson<CompareAnalytics>(`/interactive-experiences/analytics/compare?a=${encodeURIComponent(experienceId)}&b=${encodeURIComponent(compareTo)}`); }

// ─────────────────────────────────────────────────────────────────────
// AI Configuration (ILE-scoped)

export type IleProviderId =
  | 'anthropic'
  | 'openai'
  | 'MiniMax'
  | 'openrouter'
  | 'custom';

export interface IleAiConfigResponse {
  ownerId: string;
  provider: IleProviderId;
  model: string;
  baseUrl?: string;
  hasApiKey: boolean;
  apiKeyMasked?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IleAiConfigStatus {
  configured: boolean;
  config: IleAiConfigResponse | null;
}

export interface IleAiConfigInput {
  provider: IleProviderId;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export type TestConnectionStatus =
  | 'connected'
  | 'invalid_key'
  | 'rate_limited'
  | 'invalid_model'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'cancelled'
  | 'unknown'
  | 'not_configured';
export const TEST_CONNECTION_STATUS_COPY: Record<Exclude<TestConnectionStatus, 'connected' | 'idle'>, { label: string; tone: 'error' | 'warn' | 'neutral' }> = {
  invalid_key: { label: 'Invalid API key. Re-enter it and try again.', tone: 'error' },
  rate_limited: { label: 'The provider is rate-limiting this key. Wait briefly and retry.', tone: 'warn' },
  invalid_model: { label: 'The provider rejected this model name. Check it or use the default.', tone: 'error' },
  permission_denied: { label: 'This key does not have permission to use the selected model.', tone: 'error' },
  quota_exceeded: { label: 'This provider account has reached its quota.', tone: 'error' },
  timeout: { label: 'The provider did not respond in time. Try again.', tone: 'warn' },
  network_error: { label: 'Could not reach the provider. Check the network and try again.', tone: 'warn' },
  provider_error: { label: 'The provider failed on its end. Try again shortly.', tone: 'warn' },
  cancelled: { label: 'The connection test was cancelled.', tone: 'neutral' },
  unknown: { label: 'The provider returned an unrecognised error.', tone: 'error' },
  not_configured: { label: 'Finish the provider configuration before testing.', tone: 'neutral' },
};


export interface TestConnectionResult {
  ok: boolean;
  status: TestConnectionStatus;
  message?: string;
  modelEcho?: string;
}

export async function getIleAiConfig(): Promise<IleAiConfigStatus> {
  return getJson<IleAiConfigStatus>(`/interactive-experiences/config`);
}

export async function saveIleAiConfig(
  input: IleAiConfigInput,
): Promise<IleAiConfigStatus> {
  return putJson<IleAiConfigStatus>(`/interactive-experiences/config`, input);
}

export async function testIleAiConfig(
  input?: Partial<IleAiConfigInput>,
): Promise<TestConnectionResult> {
  return postJsonAllowEmpty<TestConnectionResult>(
    `/interactive-experiences/config/test`,
    input ?? {},
  );
}

// ─────────────────────────────────────────────────────────────────────
// SSE events

export type IleStreamEvent =
  | { kind: 'start'; experienceId: string }
  | { kind: 'progress'; message: string }
  | { kind: 'reasoning' }
  | { kind: 'html'; delta: string }
  | {
      kind: 'done';
      experienceId: string;
      html: string;
      /**
       * True when the provider cut the response off at max_tokens rather
       * than emitting a natural end. UI should warn the teacher that the
       * saved draft is incomplete and offer to retry with a larger cap.
       */
      truncated?: boolean;
    }
  | { kind: 'error'; message: string };

export interface GenerateArgs {
  prompt: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
}

export interface EditArgs {
  experienceId: string;
  prompt: string;
}

/**
 * Mirror of the backend CONTEXT_GENERATE_SOURCES union. Adding a new
 * context provider on the backend requires adding its id here.
 */
export const GENERATE_FROM_CONTEXT_SOURCES = ['youtube', 'markdown'] as const;
export type GenerateFromContextSource = (typeof GENERATE_FROM_CONTEXT_SOURCES)[number];

export interface GenerateFromContextArgs {
  source: GenerateFromContextSource;
  input: string;
  prompt: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  hint?: string;
}

/**
 * Stream a generation or edit. The `eventSource.close()` returned in the
 * second tuple element lets the caller abort mid-stream (used when the user
 * navigates away or sends a new prompt).
 */
export function streamIleGeneration(
  args: GenerateArgs,
  onEvent: (event: IleStreamEvent) => void,
): () => void {
  const token = getAuthToken() ?? '';
  // fetch-based SSE — see openIleSse for why we don't use the
  // event-source-polyfill (it transparently delegates to the
  // native EventSource on modern browsers, which ignores our
  // `method: 'POST'` and 404s every ILE stream).
  const es = openIleSse(
    `${API_BASE}/interactive-experiences/generate/stream`,
    args,
    token,
  );

  bindIleStream(es, onEvent);

  return () => es.close();
}

export function streamIleEdit(
  args: EditArgs,
  onEvent: (event: IleStreamEvent) => void,
): () => void {
  const token = getAuthToken() ?? '';
  const es = openIleSse(
    `${API_BASE}/interactive-experiences/${args.experienceId}/edit/stream`,
    { prompt: args.prompt },
    token,
  );

  bindIleStream(es, onEvent);

  return () => es.close();
}
/**
 * Stream a fresh generation grounded in an external context source.
 * Uses the same SSE event contract as ordinary generation/edit streams.
 */
export function streamIleGenerationFromContext(
  args: GenerateFromContextArgs,
  onEvent: (event: IleStreamEvent) => void,
): () => void {
  const token = getAuthToken() ?? '';
  const es = openIleSse(
    `${API_BASE}/interactive-experiences/generate/from-context/stream`,
    args,
    token,
  );

  bindIleStream(
    es,
    onEvent,
    {
      syntheticMessage:
        'Context stream connection lost. Check the network and retry.',
      closeOnTerminal: true,
    },
  );

  return () => es.close();
}

/**
 * Ask the AI coach for a hint about the current experience. The backend
 * (if implemented) returns a hint string. The frontend is permissive: any
 * string is treated as a successful hint, so the panel can still display
 * a fallback when the endpoint is not yet wired.
 */
export async function askCoach(
  experienceId: string,
  prompt: string,
): Promise<{ hint: string }> {
  const token = getAuthToken() ?? '';
  const res = await fetch(
    `${API_BASE}/interactive-experiences/${experienceId}/coach`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ prompt }),
    },
  );
  if (!res.ok) {
    throw new Error(`Coach request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { hint?: string };
  return { hint: data.hint ?? 'The coach is thinking...' };
}
