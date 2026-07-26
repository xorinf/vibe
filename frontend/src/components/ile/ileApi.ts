import { EventSourcePolyfill, EventSourcePolyfillInit } from 'event-source-polyfill';

// The polyfill package has no @types/... shipping and the existing
// genai-api.ts treats the polyfill instance as an `EventSource`. We do
// the same so the typecheck stays clean without adding a new ambient .d.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ESPolyfill = EventSourcePolyfill as unknown as new (
  url: string,
  init?: EventSourcePolyfillInit,
) => EventSource;

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

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('firebase-auth-token');
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
  prompt: string;
  html: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
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
  const res = await fetch(`${API_BASE}${path}`, {
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
  const res = await fetch(`${API_BASE}${path}`, {
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
  const res = await fetch(`${API_BASE}${path}`, {
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
  const res = await fetch(`${API_BASE}${path}`, {
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
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
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
    const token = localStorage.getItem('firebase-auth-token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

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
  | 'network_error'
  | 'not_configured';

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
 * Stream a generation or edit. The `eventSource.close()` returned in the
 * second tuple element lets the caller abort mid-stream (used when the user
 * navigates away or sends a new prompt).
 */
export function streamIleGeneration(
  args: GenerateArgs,
  onEvent: (event: IleStreamEvent) => void,
): () => void {
  const token = localStorage.getItem('firebase-auth-token') ?? '';
  // EventSourcePolyfill supports POST + headers + body.
  const es = new ESPolyfill(`${API_BASE}/interactive-experiences/generate/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
    heartbeatTimeout: 180000,
  });

  function bind(eventName: string, kind: IleStreamEvent['kind']) {
    es.addEventListener(eventName, (raw) => {
      const msg = raw as MessageEvent;
      let parsed: any = {};
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        // tolerate non-JSON heartbeats
        return;
      }
      onEvent({ kind, ...parsed } as IleStreamEvent);
    });
  }

  bind('start', 'start');
  bind('progress', 'progress');
  bind('reasoning', 'reasoning');
  bind('html', 'html');
  bind('done', 'done');
  bind('error', 'error');

  es.onerror = (err) => {
    // Polyfill auto-reconnects; treat as soft unless we get an error event.
    console.warn('[ILE] SSE reconnecting…', err);
  };

  return () => es.close();
}

export function streamIleEdit(
  args: EditArgs,
  onEvent: (event: IleStreamEvent) => void,
): () => void {
  const token = localStorage.getItem('firebase-auth-token') ?? '';
  const es = new ESPolyfill(
    `${API_BASE}/interactive-experiences/${args.experienceId}/edit/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: args.prompt }),
      heartbeatTimeout: 180000,
    },
  );

  function bind(eventName: string, kind: IleStreamEvent['kind']) {
    es.addEventListener(eventName, (raw) => {
      const msg = raw as MessageEvent;
      let parsed: any = {};
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      onEvent({ kind, ...parsed } as IleStreamEvent);
    });
  }

  bind('start', 'start');
  bind('progress', 'progress');
  bind('reasoning', 'reasoning');
  bind('html', 'html');
  bind('done', 'done');
  bind('error', 'error');

  es.onerror = (err) => {
    console.warn('[ILE] SSE reconnecting…', err);
  };

  return () => es.close();
}