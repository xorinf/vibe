import Anthropic from '@anthropic-ai/sdk';
import {
  ChatMessage,
  ChatStream,
  ChatStreamRequest,
  ProviderAuthError,
  ProviderNetworkError,
  StreamChunk,
} from './types.js';

/**
 * How long we'll wait for the upstream provider before we hang up and
 * surface a `provider_timeout` error to the SSE channel. Generous because
 * long completions can have quiet stretches — but small enough that a
 * dead stream doesn't leak money.
 */
const UPSTREAM_DEADLINE_MS = 120_000;

/**
 * Anthropic-specific stop reasons that mean the response was truncated
 * by `max_tokens` rather than ending naturally. UI uses this to warn the
 * teacher that the saved draft is incomplete.
 *
 * See https://docs.anthropic.com/en/api/messages#stop-reason
 */
const ANTHROPIC_TRUNCATION_REASONS = new Set([
  'max_tokens',
  'model_context_window_exceeded',
]);

/**
 * Anthropic provider. Streams via the SDK's messages.stream() so we get
 * delta-by-delta events including reasoning when the model uses extended
 * thinking. Reasoning deltas are surfaced as `kind: 'reasoning'` chunks so
 * IleGenerationService can decide whether to translate them to progress.
 *
 * The model is supplied via the message array's first system-prefixed user
 * turn for MVP simplicity. In practice we let the caller pass the model via
 * the system message by encoding it in `req.system` is ugly — so we accept
 * a modelName arg in the constructor instead, and the factory wires it up.
 */
export class AnthropicProvider implements ChatStream {
  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
  ) {
    if (!apiKey) {
      throw new ProviderAuthError('Anthropic API key is empty');
    }
  }

  private client(): Anthropic {
    return new Anthropic({ apiKey: this.apiKey });
  }

  async *stream(req: ChatStreamRequest): AsyncIterable<StreamChunk> {
    const messages = req.messages.filter(
      (m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system',
    );

    // The SDK aborts the underlying fetch when we abort the controller,
    // so a stalled upstream surfaces as a clean network error instead of
    // hanging the SSE connection.
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      UPSTREAM_DEADLINE_MS,
    );

    let truncated = false;
    try {
      const stream = this.client().messages.stream(
        {
          model: this.modelName,
          max_tokens: req.maxTokens ?? 8192,
          temperature: req.temperature ?? 0.4,
          system: req.system ?? '',
          messages: messages.map((m) => ({ role: m.role, content: m.content })) as any,
        },
        { signal: controller.signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta: any = event.delta;
          if (delta.type === 'text_delta') {
            yield { kind: 'text', delta: delta.text };
          } else if (delta.type === 'thinking_delta') {
            yield { kind: 'reasoning', delta: delta.thinking ?? '' };
          }
        } else if (event.type === 'message_stop') {
          // The final SDK event carries the resolved `stop_reason`. We
          // surface it as a truncation sentinel so the calling service
          // can warn the teacher that the draft is incomplete rather
          // than saving a half-finished document silently.
          const finalMessage = await stream.finalMessage().catch(() => null);
          const reason: string | null = finalMessage?.stop_reason ?? null;
          if (reason && ANTHROPIC_TRUNCATION_REASONS.has(reason)) {
            truncated = true;
          }
        }
      }
    } catch (err: any) {
      this.translateError(err);
    } finally {
      clearTimeout(deadline);
    }
    // Defer the truncation signal to a non-chunk event so generators
    // don't have to inspect every chunk. The provider emits ONE yield
    // AFTER the stream finishes so callers always see it (even if no
    // text chunks arrived, which can happen on hard refusals).
    yield { kind: '_stream_meta', truncated };
  }

  /** Lightweight test-connection probe. */
  async testConnection(): Promise<void> {
    try {
      await this.client().messages.create({
        model: this.modelName,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err: any) {
      this.translateError(err);
    }
  }

  private translateError(err: any): never {
    const status = err?.status ?? err?.response?.status;
    const message = err?.message ?? 'Anthropic request failed';
    if (status === 401 || status === 403) {
      throw new ProviderAuthError(`Invalid API key: ${message}`);
    }
    throw new ProviderNetworkError(`Network error: ${message}`);
  }
}