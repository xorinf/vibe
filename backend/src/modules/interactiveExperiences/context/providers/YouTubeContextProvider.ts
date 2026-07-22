import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../../types.js';
import { TranscriptCleaner } from '../TranscriptCleaner.js';
import {
  ContextInput,
  ContextPhase,
  ContextProvider,
  ContextProviderError,
  GenerationContext,
} from '../types.js';
import { TranscriptStrategy } from './strategies/Strategy.js';
import { CreatorCaptionsStrategy } from './strategies/CreatorCaptionsStrategy.js';
import { AutoCaptionsStrategy } from './strategies/AutoCaptionsStrategy.js';
import { WhisperFallbackStrategy } from './strategies/WhisperFallbackStrategy.js';
import { fetchVideoMeta, requireYouTubeId } from './strategies/youtubeUtils.js';
import { ileLog } from '../../services/observability.js';

/**
 * YouTube ContextProvider — the first concrete implementation of the
 * generic `ContextProvider` interface.
 *
 * Owns its own fallback chain:
 *   1. Creator-uploaded captions  (Strategy 1 — youtube-transcript)
 *   2. Auto-generated captions   (Strategy 2 — youtube-transcript)
 *   3. Local Whisper             (Strategy 3 — yt-dlp + faster-whisper)
 *
 * The builder does not know about these strategies. It just calls
 * `buildContext` and gets back a normalized `GenerationContext`.
 *
 * INVARIANTS
 * ----------
 * - Every error is translated to `ContextProviderError` with a
 *   friendly `userMessage`. No raw library exceptions escape.
 * - Every strategy attempt is recorded in `provenance[]`. The
 *   analytics layer can later answer "what fraction of YouTube
 *   contexts fall through to Whisper?" without extra logging.
 * - `canHandle` is cheap (URL regex). No network calls.
 * - Honours `AbortSignal`; throws `cancelled` on abort.
 */
@injectable()
export class YouTubeContextProvider implements ContextProvider {
  private readonly strategies: TranscriptStrategy[];

  constructor(
    @inject(ILE_TYPES.TranscriptCleaner)
    private readonly cleaner: TranscriptCleaner,
  ) {
    // Order is load-bearing: first success wins.
    this.strategies = [
      new CreatorCaptionsStrategy(),
      new AutoCaptionsStrategy(),
      new WhisperFallbackStrategy(),
    ];
  }

  canHandle(input: ContextInput): boolean {
    if (input.source === 'youtube') return true;
    // Reject obvious non-YouTube URLs early — saving a network roundtrip.
    const primary = (input.primary || '').trim();
    if (!primary) return false;
    return /youtu\.?be/.test(primary) || /^[A-Za-z0-9_-]{11}$/.test(primary);
  }

  async buildContext(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<GenerationContext> {
    const videoId = requireYouTubeId(input.primary);

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    onPhase({ id: 'fetching-meta', label: 'Preparing video context...' });
    const meta = await fetchVideoMeta(videoId, signal);

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    const provenance: GenerationContext['provenance'] = [];
    let lastUnsupported: ContextProviderError | null = null;
    let lastTransient: ContextProviderError | null = null;

    for (const strategy of this.strategies) {
      if (signal.aborted) {
        throw new ContextProviderError(
          'Cancelled',
          'Generation cancelled.',
          'cancelled',
        );
      }

      // Surface the right user-facing label per strategy without
      // revealing implementation details.
      if (strategy.name === 'creator-captions' || strategy.name === 'auto-captions') {
        onPhase({ id: 'reading-captions', label: 'Analyzing educational content...' });
      } else if (strategy.name === 'whisper') {
        onPhase({ id: 'transcribing', label: 'Analyzing educational content...' });
      }

      const t0 = Date.now();
      try {
        const result = await strategy.extract(videoId, signal, onPhase);

        // Cleaner: dedupe, strip noise, join prose.
        const cleaned = this.cleaner.clean(result.lines);
        const hash = this.cleaner.hash(cleaned);

        provenance.push({
          strategy: strategy.name,
          outcome: 'success',
          durationMs: Date.now() - t0,
          note: result.language,
        });

        // Provider pre-summarizes when it can — gives the LLM prompt
        // a high-quality header without an extra round-trip.
        onPhase({ id: 'summarizing', label: 'Analyzing educational content...' });
        let summary;
        try {
          summary = await this.cleaner.summarize(cleaned.text, signal, {
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
          // Cleaner already degrades internally. If it still threw,
          // log and continue without a summary.
          ileLog('warn', 'context.summary.failed', {
            error: (err as Error).message,
          });
        }

        const body = {
          text: cleaned.text,
          lines: cleaned.lines,
          chapters: cleaned.lines.length
            ? cleaned.lines.slice(0, 30).map((ln, i) => ({
                title: `Segment ${i + 1}`,
                startSec: ln.startSec,
                text: ln.text,
              }))
            : undefined,
          meta: {
            videoId,
            durationSec: meta.durationSec,
            author: meta.author,
            thumbnailUrl: meta.thumbnailUrl,
            language: result.language,
            transcriptHash: hash,
          },
        };

        return {
          source: 'youtube',
          title: meta.title || `YouTube video ${videoId}`,
          originalInput: input.primary,
          body,
          summary,
          provenance,
        };
      } catch (err) {
        if (signal.aborted) {
          throw new ContextProviderError(
            'Cancelled',
            'Generation cancelled.',
            'cancelled',
          );
        }
        if (!(err instanceof ContextProviderError)) {
          // Defensive: strategy should have wrapped this already.
          ileLog('error', 'context.strategy.unexpected_error', {
            strategy: strategy.name,
            error: (err as Error).message,
          });
          continue;
        }

        const durationMs = Date.now() - t0;

        // 'unsupported' (private / region / age-restricted) is a
        // hard stop — no point trying other strategies.
        if (err.kind === 'unsupported') {
          provenance.push({
            strategy: strategy.name,
            outcome: 'unavailable',
            durationMs,
            note: err.message,
          });
          lastUnsupported = err;
          break;
        }
        if (err.kind === 'cancelled') {
          throw err;
        }
        if (err.kind === 'transient') {
          lastTransient = err;
          provenance.push({
            strategy: strategy.name,
            outcome: 'failed',
            durationMs,
            note: err.message,
          });
          continue;
        }
        if (err.kind === 'not_configured') {
          // Whisper deps missing — keep trying captions but record
          // this so the final user message can mention it.
          provenance.push({
            strategy: strategy.name,
            outcome: 'failed',
            durationMs,
            note: 'not_configured: ' + err.message,
          });
          lastTransient = err;
          continue;
        }
        // 'unavailable' / 'invalid_input' / 'unknown' → record, fall through.
        provenance.push({
          strategy: strategy.name,
          outcome: 'failed',
          durationMs,
          note: err.message,
        });
      }
    }

    // All strategies exhausted.
    if (lastUnsupported) {
      throw lastUnsupported;
    }
    if (lastTransient && lastTransient.kind === 'transient') {
      throw lastTransient;
    }

    // Every strategy returned `unavailable` / similar — give the
    // teacher a friendly message. If the Whisper strategy recorded a
    // not_configured note, mention the install hint.
    const whisperNote = provenance.find(
      (p) => p.strategy === 'whisper' && (p.note ?? '').includes('not_configured'),
    );
    if (whisperNote) {
      throw new ContextProviderError(
        'YouTube captions unavailable and local transcription is not configured',
        'YouTube captions unavailable and local transcription is not configured. ' +
          'Install yt-dlp and faster-whisper to enable automatic transcription.',
        'not_configured',
      );
    }

    throw new ContextProviderError(
      'All YouTube strategies returned unavailable',
      'Unable to extract educational content from this video. Try another video.',
      'unavailable',
      { provenance },
    );
  }
}
