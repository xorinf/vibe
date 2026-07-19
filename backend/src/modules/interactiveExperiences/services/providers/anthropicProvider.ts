import Anthropic from '@anthropic-ai/sdk';
import {
  ChatMessage,
  ChatStream,
  ChatStreamRequest,
  classifyUpstreamError,
  asProviderError,
  StreamChunk,
} from './types.js';

/**
 * How long we'll wait for the upstream provider before we hand up and
 * surface a `ProviderTimeoutError` to the SSE channel. Generous
 * because long completions can have quiet stretches — but small enough
 * that a dead stream doesn't leak money.
 *
 * SECURITY-TODO(production): keep this tunable via env. The local dev
 * default is fine; production should set ILE_UPSTREAM_TIMEOUT_MS based
 * on observed p99 latencies for the chosen model.
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
 *
 * Cancellation: any of the following stop the stream and throw a
 * `ProviderCancelledError`:
 *
 *   - The caller passing `req.signal.aborted` (browser disconnect, editor
 *     cancel, timeout via the SSE layer)
 *   - The internal 120s deadline firing
 *   - The Anthropic SDK's own heartbeat noticing the connection dropped
 */
export class AnthropicProvider implements ChatStream {
  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
  ) {
    if (!apiKey) {
      throw asProviderError(
        { name: 'ProviderAuthError', message: 'Anthropic API key is empty' },
        'anthropic',
      );
    }
  }

  private client(): Anthropic {
    return new Anthropic({ apiKey: this.apiKey });
  }

  async *stream(req: ChatStreamRequest & { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    const messages = req.messages.filter(
      (m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system',
    );

    // Combine the upstream deadline with any signal the caller passed.
    // We honor whichever fires first.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), UPSTREAM_DEADLINE_MS);
    const onCallerAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) {
        clearTimeout(deadline);
        throw asProviderError(
          { name: 'AbortError' },
          'anthropic',
        );
      }
      req.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const onControllerAbort = () => {
      if (req.signal) req.signal.removeEventListener('abort', onCallerAbort);
      clearTimeout(deadline);
    };
    controller.signal.addEventListener('abort', onControllerAbort, { once: true });

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
      // The Anthropic SDK throws its own error shapes. Map them onto
      // the typed taxonomy so the caller can classify confidently.
      throw asProviderError(err, 'anthropic');
    } finally {
      clearTimeout(deadline);
      onControllerAbort();
    }
    // Defer the truncation signal to a non-chunk event so generators
    // don't have to inspect every chunk. The provider emits ONE yield
    // AFTER the stream finishes so callers always see it (even if no
    // text chunks arrived, which can happen on hard refusals).
    yield { kind: '_stream_meta', truncated };
  }

  /** Lightweight test-connection probe. */
  async testConnection(req: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.client().messages.create(
        {
          model: this.modelName,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        { signal: req.signal },
      );
    } catch (err: any) {
      throw asProviderError(err, 'anthropic');
    }
  }
}