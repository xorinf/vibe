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
  MiniMax: { baseUrl: 'https://api.MiniMax.com/v1', defaultModel: 'MiniMax/MiniMax-M3' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto' },
};

/** Per-owner persisted config. Returned to the UI without the API key in
 * the response (the key is write-only from the client's perspective). */
export interface IleAiConfig {
  ownerId: string;
  provider: IleProviderId;
  /** Plaintext at rest. See IleAiConfigRepository for the prod-encryption TODO. */
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

export interface ChatStream {
  stream(req: ChatStreamRequest): AsyncIterable<StreamChunk>;
}

/** Test-connection probe — minimal request to verify credentials work. */
export interface TestConnectionResult {
  ok: boolean;
  /** Stable status code surfaced to the UI for the four-state indicator. */
  status: 'connected' | 'invalid_key' | 'network_error' | 'not_configured';
  message?: string;
  /** Optional model echoed back so the UI can confirm what's reachable. */
  modelEcho?: string;
}

/** Errors thrown by the provider layer that should map to TestConnectionResult
 * statuses without leaking stack traces to the UI. */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNetworkError';
  }
}