import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { ContextProviderRegistry } from './ContextProviderRegistry.js';
import { TranscriptCleaner } from './TranscriptCleaner.js';
import {
  ContextInput,
  ContextPhase,
  ContextProviderError,
  GenerationContext,
} from './types.js';
import { ileLog } from '../services/observability.js';

/**
 * Below this character count the transcript is short enough that the
 * LLM doesn't need a separate summary call — we just pass the cleaned
 * text directly. Above this, we run the LLM-backed summarizer to
 * extract key concepts + a short summary the system prompt can quote.
 */
const SUMMARIZE_PROVIDER_THRESHOLD_CHARS = 1_500;

/**
 * Thin orchestrator: pick the right provider, run it, and (optionally)
 * summarize the result.
 *
 * The provider owns its own internal fallback chain (so the YouTube
 * provider tries creator captions → auto captions → Whisper). The
 * builder does NOT know about strategies — that's the provider's job.
 *
 * This keeps the builder stable as new providers are added. A future
 * "PDF" provider might have a completely different fallback strategy
 * ("primary parse → OCR → manual upload") without touching the
 * builder.
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
   * Build the normalized context for an input. Emits progress via
   * `onPhase` so the SSE layer can forward it to the teacher.
   *
   * Errors: only `ContextProviderError` ever escapes. Raw library
   * exceptions (yt-dlp stderr, network failures, parse errors) are
   * already translated by the provider layer.
   */
  async build(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<GenerationContext> {
    onPhase({ id: 'picking-source', label: 'Preparing video context...' });

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

    let ctx: GenerationContext;
    try {
      ctx = await provider.buildContext(input, signal, onPhase);
    } catch (err) {
      if (err instanceof ContextProviderError) {
        ileLog('warn', 'context.provider_error', {
          source: input.source,
          kind: err.kind,
          message: err.message,
        });
        throw err;
      }
      // Defensive: provider should have wrapped this already.
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

    // Provider may have already pre-summarized (some providers know
    // their content well enough). If not, and the text is long enough
    // to justify the cost, run the cleaner's LLM summarizer.
    if (
      !ctx.summary &&
      ctx.body.text.length >= SUMMARIZE_PROVIDER_THRESHOLD_CHARS
    ) {
      onPhase({ id: 'summarizing', label: 'Analyzing educational content...' });
      try {
        ctx.summary = await this.cleaner.summarize(
          ctx.body.text,
          signal,
          input.ownerId ? { ownerId: input.ownerId } : {},
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError' || signal.aborted) {
          throw new ContextProviderError(
            'Cancelled during summarization',
            'Generation cancelled.',
            'cancelled',
            err,
          );
        }
        // Cleaner already degrades to extractive on LLM failure; if we
        // still got an error here it's structural — log and continue
        // without a summary rather than fail the whole build.
        ileLog('warn', 'context.summary.failed', {
          error: (err as Error).message,
        });
      }
    }

    return ctx;
  }
}
