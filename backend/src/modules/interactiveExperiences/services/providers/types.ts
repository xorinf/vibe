/**
 * Provider abstraction for ILE generation.
 *
 * Scoped strictly to the Interactive Learning Experiences module — do NOT
 * lift this into shared/ or wire it into the global AI config. The whole
 * point is to keep ILE self-contained.
 *
 * Each provider exposes a `ChatStream` interface (async iterable over
 * text-delta chunks + reasoning-delta chunks when the model emits them).
 * This is the minimum surface IleGenerationService needs.
 *
 * Why a custom interface instead of using each SDK's native streaming
 * shape? So the ILE generator can stay provider-agnostic and we can add
 * new providers (Gemini, Mistral, etc.) without touching the generation
 * service.
 */

export type IleProviderId =
  | 'anthropic'
  | 'openai'
  | 'MiniMax'
  | 'openrouter'
  | 'custom';

export const PROVIDER_DEFAULTS: Record<
  Exclude<IleProviderId, 'custom'>,
  { baseUrl: string; defaultModel: string }
> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  // ponytail: MiniMax's Anthropic-compatible endpoint is the working
  // path for the M-series models (the OpenAI-compatible URL routes 4xx/empty
  // responses). Teachers who want the OpenAI-compat path can pick
  // `custom` and paste the URL themselves.
  //
  // Defaults verified against https://platform.minimax.io/docs/api-reference/text-anthropic-api
  // (2026-08). Model name is bare "MiniMax-M3" with no org/prefix — the
  // old "MiniMax/MiniMax-M3" string was an OpenRouter convention leaking
  // in from when MiniMax was first wired through openrouter/auto.
  MiniMax: {baseUrl: 'https://api.minimax.io/anthropic', defaultModel: 'MiniMax-M3'},
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto' },
};

/** Per-owner persisted config. Returned to the UI without the API key in
 * the response (the key is write-only from the client's perspective). */
export interface IleAiConfig {
  ownerId: string;
  provider: IleProviderId;
  /** Plaintext API key. Handled exclusively by the keystore at the
   *  application boundary; MUST NOT be logged or serialised back to
   *  the client. */
  apiKey: string;
  model: string;
  /** Only meaningful for `custom` (and `openrouter`, where a custom base URL is allowed). */
  baseUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Sanitized version sent to the UI. */
export type IleAiConfigResponse = Omit<IleAiConfig, 'apiKey'> & {
  hasApiKey: boolean;
  apiKeyMasked?: string;
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatStreamRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  /**
   * Provider-internal metadata emitted exactly ONCE at the end of every
   * stream. Carries flags that don't belong on individual chunks but the
   * calling service needs to act on — e.g. `truncated` so the UI can warn
   * the teacher that `max_tokens` cut off the response. Generation code
   * must filter these out before forwarding to the SSE channel.
   */
  | { kind: '_stream_meta'; truncated?: boolean };

export interface ChatStreamResult {
  text: string;
}

/**
 * The transport interface. Providers MUST honour external cancellation:
 * `AbortSignal` is plumbed through `request.signal` and a cancelled
 * stream MUST throw a `ProviderCancelledError` once it stops iterating.
 */
export interface ChatStream {
  stream(req: ChatStreamRequest & { signal?: AbortSignal }): AsyncIterable<StreamChunk>;
}

/**
 * Test-connection probe — minimal request to verify credentials work.
 * Same cancellation contract as `stream()`.
 */
export interface TestConnectionResult {
  ok: boolean;
  /**
   * Stable status code surfaced to the UI for the four-state indicator.
   *
   * The set has grown to support the typed error taxonomy below. New
   * providers must return one of these — never a free-form string.
   */
  status:
    | 'connected'
    | 'not_configured'
    | 'invalid_key'
    | 'rate_limited'
    | 'invalid_model'
    | 'permission_denied'
    | 'quota_exceeded'
    | 'timeout'
    | 'network_error'
    | 'provider_error'
    | 'cancelled'
    | 'unknown';
  message?: string;
  /** Optional model echoed back so the UI can confirm what's reachable. */
  modelEcho?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Typed provider-error taxonomy
// ─────────────────────────────────────────────────────────────────────

/**
 * The closed set of provider error categories. Every provider throws
 * one of these on failure; everything else (string messages, SDK error
 * objects) is mapped onto these at the provider boundary.
 *
 * Why a closed set rather than letting `throw new Error('…')` bubble:
 *
 *   1. UI needs actionable copy ("rate limited — wait and retry" is
 *      different from "invalid key — re-enter").
 *   2. Telemetry needs to bucket failures to compute SLOs.
 *   3. Cancellation can't be confused with network failure (the
 *      teacher clicking Cancel doesn't get retried automatically).
 *   4. Future quota / billing errors surface distinctly from auth errors.
 */
export type ProviderErrorKind =
  /** Request took longer than the upstream deadline. */
  | 'timeout'
  /** Provider returned 429. The teacher should retry shortly. */
  | 'rate_limit'
  /** Provider returned 401 / 403 / "invalid api key". */
  | 'authentication'
  /** Provider returned 403 but specifically about permission / scope. */
  | 'permission'
  /** Provider returned 404 / "model not found" / "model not available for this key". */
  | 'invalid_model'
  /** Provider returned 429-with-quota or "you have used your monthly credits". */
  | 'quota'
  /** Network error: TCP reset, DNS failure, TLS handshake, timeout-before-send. */
  | 'network'
  /** Provider returned 5xx, or a non-JSON body that looked like a successful response. */
  | 'provider_internal'
  /** External cancellation: AbortSignal, browser disconnect, editor Cancel. */
  | 'cancelled'
  /** Anything we couldn't classify. Always fixable — should reduce over time. */
  | 'unknown';

/**
 * The base class every provider-emitted error extends. Carries the
 * closed `kind` taxonomy, the original upstream status code (if any),
 * and the thrower's name so logs can identify the source.
 */
export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind;
  /** Upstream HTTP status (if applicable). */
  readonly upstreamStatus?: number;
  /** Provider name that emitted the error. */
  readonly providerName: string;

  constructor(
    message: string,
    opts: { upstreamStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.upstreamStatus = opts.upstreamStatus;
    this.providerName = '';
    if (opts.cause !== undefined) {
      // ES2022 supports Error.cause natively; this branch keeps the
      // older Node 18 typings happy.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly kind = 'timeout' as const;
}
export class ProviderRateLimitError extends ProviderError {
  readonly kind = 'rate_limit' as const;
}
export class ProviderAuthenticationError extends ProviderError {
  readonly kind = 'authentication' as const;
}
export class ProviderPermissionError extends ProviderError {
  readonly kind = 'permission' as const;
}
export class ProviderInvalidModelError extends ProviderError {
  readonly kind = 'invalid_model' as const;
}
export class ProviderQuotaError extends ProviderError {
  readonly kind = 'quota' as const;
}
export class ProviderNetworkError extends ProviderError {
  readonly kind = 'network' as const;
}
export class ProviderInternalError extends ProviderError {
  readonly kind = 'provider_internal' as const;
}
export class ProviderCancelledError extends ProviderError {
  readonly kind = 'cancelled' as const;
}
export class ProviderUnknownError extends ProviderError {
  readonly kind = 'unknown' as const;
}

// ─────────────────────────────────────────────────────────────────────
// Mapping helper — provider errors → TestConnectionResult.status
// ─────────────────────────────────────────────────────────────────────

/**
 * Project a typed ProviderError onto the stable `TestConnectionResult.status`
 * set (used by the UI's four/five-state indicator) and into the actionable
 * `message` shown on screen.
 *
 * Centralising the mapping here means:
 *
 *   - Adding a new kind requires a single case here, not a sweep across
 *     every provider / every controller.
 *   - The actionable strings stay in one place (single source of truth
 *     for the copy).
 */
export function providerErrorToTestConnectionStatus(
  err: ProviderError,
): { status: TestConnectionResult['status']; message: string } {
  switch (err.kind) {
    case 'authentication':
      return {
        status: 'invalid_key',
        message: 'Invalid API key — re-enter it in the AI Configuration panel.',
      };
    case 'permission':
      return {
        status: 'permission_denied',
        message: 'Your key does not have access to this model. Pick another model or contact your provider.',
      };
    case 'invalid_model':
      return {
        status: 'invalid_model',
        message: 'Provider rejected the model name. Check the spelling or use the provider default.',
      };
    case 'rate_limit':
      return {
        status: 'rate_limited',
        message: 'Provider is rate-limiting your key. Wait a few seconds and try again.',
      };
    case 'quota':
      return {
        status: 'quota_exceeded',
        message: 'Your account has hit its quota. Add billing or pick a different provider.',
      };
    case 'timeout':
      return {
        status: 'timeout',
        message: 'The provider did not respond in time. Retry — and check ILE_UPSTREAM_TIMEOUT_MS if this keeps happening.',
      };
    case 'cancelled':
      return {
        status: 'cancelled',
        message: 'Cancelled before the provider responded.',
      };
    case 'network':
      return {
        status: 'network_error',
        message: 'Network error reaching the provider. Check your connection and the provider status page.',
      };
    case 'provider_internal':
      return {
        status: 'provider_error',
        message: 'The provider failed on its end. Retry — and check the provider status page if it persists.',
      };
    case 'unknown':
    default:
      return {
        status: 'unknown',
        message: err.message || 'Unknown error. The provider returned something we did not recognise.',
      };
  }
}

/**
 * Heuristic mapping from a generic upstream error (HTTP status, errno,
 * SocketError message) to the closest typed `ProviderError` instance.
 *
 * Provider implementations call this from their catch blocks; it keeps
 * each provider's translate path small and uniform.
 */
export function classifyUpstreamError(args: {
  upstreamStatus?: number;
  name?: string;
  message?: string;
  provider: string;
  cause?: unknown;
}): ProviderError {
  // Cancellation signal dominates everything.
  if (
    args.name === 'AbortError' ||
    args.name === 'APIUserAbortError' ||
    args.name === 'APIConnectionAbortedError' ||
    args.name === 'CanceledError'
  ) {
    return new ProviderCancelledError(
      'Cancelled by client',
      { cause: args.cause },
    );
  }
  const status = args.upstreamStatus;
  if (status === 401 || status === 403) {
    return new ProviderAuthenticationError(
      args.message ??
        `Provider ${args.provider} rejected the credentials (HTTP ${status})`,
      { upstreamStatus: status, cause: args.cause },
    );
  }
  if (status === 404) {
    return new ProviderInvalidModelError(
      args.message ?? `Model not found on ${args.provider}`,
      { upstreamStatus: status, cause: args.cause },
    );
  }
  if (status === 408 || status === 504) {
    return new ProviderTimeoutError(
      args.message ?? `${args.provider} timed out (HTTP ${status})`,
      { upstreamStatus: status, cause: args.cause },
    );
  }
  if (status === 429) {
    // Differentiate quota vs rate_limit by message content. Most providers
    // embed "quota" in the human-readable message when billing is hit.
    const m = (args.message ?? '').toLowerCase();
    if (m.includes('quota') || m.includes('credit') || m.includes('billing')) {
      return new ProviderQuotaError(args.message ?? 'Quota exceeded', {
        upstreamStatus: status,
        cause: args.cause,
      });
    }
    return new ProviderRateLimitError(args.message ?? 'Rate limited', {
      upstreamStatus: status,
      cause: args.cause,
    });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderInternalError(
      args.message ?? `${args.provider} error (HTTP ${status})`,
      { upstreamStatus: status, cause: args.cause },
    );
  }
  // No HTTP status — likely a network/timeout/connection error.
  const m = (args.message ?? '').toLowerCase();
  if (
    m.includes('timeout') ||
    m.includes('aborted') ||
    m.includes('etimedout')
  ) {
    return new ProviderTimeoutError(args.message ?? 'Request timed out', {
      cause: args.cause,
    });
  }
  // Name-based fallbacks for fetch failures.
  if (
    args.name === 'TypeError' ||
    args.name === 'FetchError' ||
    args.name === 'NetworkError'
  ) {
    return new ProviderNetworkError(args.message ?? 'Network error', {
      cause: args.cause,
    });
  }
  return new ProviderUnknownError(args.message ?? 'Unknown provider error', {
    cause: args.cause,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Deprecated aliases
// ─────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use `ProviderAuthenticationError` (or any other typed error
 * from the taxonomy above) instead. The legacy alias is retained so
 * existing imports compile for now — but new code MUST throw one of the
 * typed errors so the UI and the log pipeline can classify errors
 * correctly.
 */
export class ProviderAuthError extends ProviderAuthenticationError {}

/**
 * Normalise a thrown value into a `ProviderError`. Use this in catch
 * blocks that don't know what they caught (e.g. after a runtime await).
 */
export function asProviderError(
  err: unknown,
  providerName: string,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as {
    name?: string;
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  return classifyUpstreamError({
    upstreamStatus: e?.status ?? e?.response?.status,
    name: e?.name,
    message: e?.message ?? (err instanceof Error ? err.message : String(err)),
    provider: providerName,
    cause: err,
  });
}