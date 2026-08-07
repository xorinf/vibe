import {
  ChatStream,
  ChatStreamRequest,
  classifyUpstreamError,
  asProviderError,
  StreamChunk,
} from './types.js';

/**
 * Generic OpenAI-Chat-Completions streaming provider.
 *
 * Used for: OpenAI, MiniMax, OpenRouter, and any Custom OpenAI-compatible
 * endpoint. We deliberately don't pull in the `openai` SDK because (a)
 * OpenAI-compatible providers diverge subtly and (b) raw fetch + SSE keeps
 * the dependency footprint zero. The wire format is stable enough that
 * the SSE parser below works across all of them.
 *
 * The endpoint shape we hit:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer ***
 *   Body: { model, messages, temperature, max_tokens, stream: true }
 *   Response: SSE — `data: {...}\n\n` per chunk, terminated by `data: [DONE]`.
 */

/**
 * How long we'll wait for the upstream provider before we abort the fetch.
 * Generous because long completions can have quiet stretches, but small
 * enough that a dead stream doesn't leak money.
 *
 * Tune via `ILE_UPSTREAM_TIMEOUT_MS`. Production should set this based
 * on observed p99 latencies for the chosen model.
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

function resolveUpstreamTimeoutMs(): number {
  const raw = process.env.ILE_UPSTREAM_TIMEOUT_MS;
  if (!raw) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ile] ILE_UPSTREAM_TIMEOUT_MS=${raw} is not a positive integer; using default ${DEFAULT_UPSTREAM_TIMEOUT_MS}ms.`,
    );
    return DEFAULT_UPSTREAM_TIMEOUT_MS;
  }
  return parsed;
}
const UPSTREAM_DEADLINE_MS = resolveUpstreamTimeoutMs();

/**
 * OpenAI-compatible `finish_reason` values that mean the response was cut
 * at `max_tokens` rather than ending naturally. Captured per-chunk from
 * `choices[0].finish_reason`; the LAST non-null value wins.
 */
const OPENAI_TRUNCATION_REASONS = new Set(['length']);

/**
 * Reasoning fields we honour across vendor differences. Anything that
 * isn't a content/role field counts. The list is intentionally narrow —
 * some providers attach all kinds of delta metadata (e.g. role, finish
 * reasons) and we don't want to spam the analytics stream with those.
 */
const REASONING_DELTA_KEYS = ['reasoning_content', 'reasoning', 'thinking'];

export class OpenAICompatibleProvider implements ChatStream {
  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly baseUrl: string,
  ) {
    if (!apiKey) {
      throw asProviderError(
        { name: 'ProviderAuthError', message: 'API key is empty' },
        'openai-compatible',
      );
    }
    if (!baseUrl) {
      throw asProviderError(
        { name: 'ProviderAuthError', message: 'Base URL is required for OpenAI-compatible providers' },
        'openai-compatible',
      );
    }
  }

  private url(): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  private buildBody(req: ChatStreamRequest): unknown {
    // OpenAI accepts a system role inside messages. If we have a separate
    // `system` field we splice it in as the first system message.
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    return {
      model: this.modelName,
      messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
    };
  }

  /**
   * Parse an SSE stream into our unified StreamChunk shape. Returns the
   * fetch Response so the caller is responsible for reading the body and
   * aborting on disconnect.
   *
   * Cancellation:
   *   - The internal 120s deadline fires controller.abort() automatically.
   *   - The caller can pass `req.signal`; we wire it into our internal
   *     controller via addEventListener('abort') so the caller's signal
   *     propagates into the fetch.
   */
  async *stream(req: ChatStreamRequest & { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    const internal = new AbortController();
    const deadline = setTimeout(() => internal.abort(), UPSTREAM_DEADLINE_MS);
    if (req.signal) {
      if (req.signal.aborted) {
        clearTimeout(deadline);
        throw asProviderError({ name: 'AbortError' }, 'openai-compatible');
      }
      const onCallerAbort = () => internal.abort();
      req.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(this.buildBody(req)),
        signal: internal.signal,
      });
    } catch (err: any) {
      clearTimeout(deadline);
      // fetch wraps AbortError; let the typed mapping classify it.
      if (err?.name === 'AbortError' && req.signal?.aborted) {
        throw asProviderError({ name: 'AbortError' }, 'openai-compatible');
      }
      throw classifyUpstreamError({
        name: err?.name,
        message: err?.message ?? String(err),
        provider: 'openai-compatible',
        cause: err,
      });
    }

    if (response.status === 401 || response.status === 403) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        upstreamStatus: response.status,
        provider: 'openai-compatible',
        message: `Invalid API key (HTTP ${response.status})`,
        cause: response,
      });
    }
    if (response.status === 404) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        upstreamStatus: 404,
        provider: 'openai-compatible',
        message: 'Model not found on the configured endpoint',
      });
    }
    if (response.status === 408 || response.status === 504) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        upstreamStatus: response.status,
        provider: 'openai-compatible',
        message: `Upstream timeout (HTTP ${response.status})`,
      });
    }
    if (response.status === 429) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        upstreamStatus: 429,
        provider: 'openai-compatible',
        message: 'Rate limited or quota exceeded',
      });
    }
    if (!response.ok || !response.body) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        upstreamStatus: response.status,
        provider: 'openai-compatible',
        message: `Provider responded ${response.status} ${response.statusText}`,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let truncated = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line. Split on \n\n to handle
        // multiple events arriving in a single chunk.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const evt of events) {
          for (const line of evt.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              // Clean termination — the caller will see `done: true` from
              // the reader loop. We still yield nothing here.
              return;
            }
            let parsed: any;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // tolerate non-JSON heartbeat lines
            }
            const choice = parsed?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            const text = delta.content;
            if (typeof text === 'string' && text.length > 0) {
              yield { kind: 'text', delta: text };
            }
            // Some providers expose reasoning in `delta.reasoning_content`
            // (DeepSeek, MiniMax with reasoning) or a separate field. We
            // skip `role` and any other non-reasoning-string metadata.
            for (const k of REASONING_DELTA_KEYS) {
              const r = delta[k];
              if (typeof r === 'string' && r.length > 0) {
                yield { kind: 'reasoning', delta: r };
              }
            }
            // finish_reason arrives on the LAST chunk (sometimes on the
            // chunk that emits [DONE]). Only set; never unset.
            if (typeof choice.finish_reason === 'string') {
              if (OPENAI_TRUNCATION_REASONS.has(choice.finish_reason)) {
                truncated = true;
              }
            }
          }
        }
      }
    } finally {
      clearTimeout(deadline);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
    // Emit the provider-internal metadata sentinel so the generator sees
    // the truncated flag without having to scan every chunk.
    yield { kind: '_stream_meta', truncated };
  }

  /** Lightweight test-connection probe. Reuses the streaming endpoint with
   * max_tokens=1 and aborts after the first chunk. */
  async testConnection(req: { signal?: AbortSignal } = {}): Promise<void> {
    const body = {
      model: this.modelName,
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      max_tokens: 1,
      stream: false,
    };
    const internal = new AbortController();
    const deadline = setTimeout(() => internal.abort(), UPSTREAM_DEADLINE_MS);

    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: req.signal
          ? mergeSignals(internal.signal, req.signal)
          : internal.signal,
      });
    } catch (err: any) {
      clearTimeout(deadline);
      throw classifyUpstreamError({
        name: err?.name,
        provider: 'openai-compatible',
        message: err?.message ?? String(err),
        cause: err,
      });
    }
    clearTimeout(deadline);
    if (response.status === 401 || response.status === 403) {
      throw classifyUpstreamError({
        upstreamStatus: response.status,
        provider: 'openai-compatible',
        message: `Invalid API key (HTTP ${response.status})`,
      });
    }
    if (!response.ok) {
      throw classifyUpstreamError({
        upstreamStatus: response.status,
        provider: 'openai-compatible',
        message: `Provider responded ${response.status} ${response.statusText}`,
      });
    }
    // 200 + valid JSON body = reachable. We don't validate the response shape
    // because OpenAI-compat providers vary wildly; status 200 is enough.
  }
}

/**
 * Build a combined `AbortSignal` that fires when EITHER of its inputs
 * fires. We use this to merge the upstream deadline signal with the
 * caller's signal in the test-connection probe.
 */
function mergeSignals(
  a: AbortSignal,
  b: AbortSignal,
): AbortSignal {
  const c = new AbortController();
  if (a.aborted || b.aborted) c.abort();
  const onAbort = () => {
    if (!a.aborted) a.addEventListener('abort', onAbort, { once: true });
    if (!b.aborted) b.addEventListener('abort', onAbort, { once: true });
    c.abort();
  };
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return c.signal;
}