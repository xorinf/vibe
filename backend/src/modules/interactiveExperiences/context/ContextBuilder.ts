import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { ContextProviderRegistry } from './ContextProviderRegistry.js';
import { TranscriptCleaner } from './TranscriptCleaner.js';
import {
  CONTEXT_PHASES,
  ContextInput,
  ContextPhase,
  ContextProviderError,
  ContextSource,
  GenerationContext,
} from './types.js';
import { ileLog } from '../services/observability.js';

/**
 * Hard cap on the joined `mergedContent`. The LLM prompt quotes up to
 * this many characters of context; over it, we trim with a marker.
 * Generous (≈3,000 tokens) so most contexts fit; bounded for cost.
 */
const MERGED_CONTENT_CAP_CHARS = 12_000;

/**
 * Per-source content cap applied before merging. Prevents a single
 * source from blowing the budget.
 */
const PER_SOURCE_CONTENT_CAP_CHARS = 50_000;

/**
 * Below this character count the merged content is short enough that
 * the LLM doesn't need a separate summary call — we pass the text
 * directly.
 */
const SUMMARIZE_THRESHOLD_CHARS = 1_500;

/**
 * Thin orchestrator. Responsibilities ONLY:
 *
 *   1. Locate the right provider for the input (registry lookup).
 *   2. Invoke the provider — get back one ContextSource.
 *   3. Normalize / cap content.
 *   4. Optionally summarize (LLM or extractive fallback).
 *   5. Compose a GenerationContext wrapping the source(s).
 *
 * Anything beyond that (provider-specific logic, branching on source
 * type, custom merge strategies, persistence, …) belongs elsewhere.
 * If this file grows, the abstraction is wrong.
 *
 * NOTE on multi-source: v1 only calls ONE provider per request, so
 * the resulting `GenerationContext.sources` has length 1. The shape
 * is already multi-source-capable — future flows that need to
 * combine "current lesson + YouTube" or "PDF + multiple videos"
 * compose multiple providers here.
 */
@injectable()
export class ContextBuilder {
  constructor(
    @inject(ILE_TYPES.ContextProviderRegistry)
    private readonly registry: ContextProviderRegistry,
    @inject(ILE_TYPES.TranscriptCleaner)
    private readonly cleaner: TranscriptCleaner,
  ) {}

  /**
   * Build the composed context for one input.
   *
   * Emits progress via `onPhase`. The SSE layer forwards each call to
   * the existing `progress` event channel — no parallel protocol.
   *
   * Errors: only `ContextProviderError` ever escapes. Raw library
   * exceptions are already translated by the provider layer.
   */
  async build(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<GenerationContext> {
    onPhase(CONTEXT_PHASES.PREPARING_CONTEXT);

    const provider = this.registry.findProvider(input);
    if (!provider) {
      ileLog('warn', 'context.no_provider', {
        source: input.source,
        primaryLen: input.primary.length,
      });
      throw new ContextProviderError(
        `No provider registered for source=${input.source}`,
        "We don't know how to use that input yet. Try a different source.",
        'unsupported',
      );
    }

    let source: ContextSource;
    try {
      source = await provider.extract(input, signal, onPhase);
    } catch (err) {
      if (err instanceof ContextProviderError) {
        ileLog('warn', 'context.provider_error', {
          source: input.source,
          kind: err.kind,
          message: err.message,
        });
        throw err;
      }
      ileLog('error', 'context.unexpected_error', {
        source: input.source,
        error: (err as Error).message,
      });
      throw new ContextProviderError(
        `Provider threw unexpected error: ${(err as Error).message}`,
        'Unable to extract educational content from this source. Try another one.',
        'unknown',
        err,
      );
    }

    // Normalize content length on the source. Providers shouldn't
    // expose arbitrarily large bodies; this is the safety net.
    source.content = capText(source.content, PER_SOURCE_CONTENT_CAP_CHARS);

    const mergedContent = capText(source.content, MERGED_CONTENT_CAP_CHARS);
    const ctx: GenerationContext = {
      sources: [source],
      mergedContent,
    };

    // Optionally summarize. The LLM-backed summarizer lives in
    // TranscriptCleaner; it gracefully degrades to extractive when
    // the owner has no AI config. Errors here are non-fatal — we
    // keep the merged content even if summarization fails.
    if (mergedContent.length >= SUMMARIZE_THRESHOLD_CHARS) {
      onPhase(CONTEXT_PHASES.SUMMARIZING);
      try {
        ctx.summary = await this.cleaner.summarize(mergedContent, signal, {
          ownerId: input.ownerId,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || signal.aborted) {
          throw new ContextProviderError(
            'Cancelled during summarization',
            'Generation cancelled.',
            'cancelled',
            err,
          );
        }
        ileLog('warn', 'context.summary.failed', {
          error: (err as Error).message,
        });
      }
    }

    return ctx;
  }
}

/**
 * Trim text to `cap` characters with a marker so the model knows the
 * document was longer than what it sees.
 */
function capText(text: string, cap: number): string {
  if (!text) return '';
  if (text.length <= cap) return text;
  return text.slice(0, cap) + ' …[context trimmed]…';
}
