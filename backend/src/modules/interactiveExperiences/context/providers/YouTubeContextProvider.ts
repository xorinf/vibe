import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../../types.js';
import { TranscriptCleaner } from '../TranscriptCleaner.js';
import {
  CONTEXT_PHASES,
  ContextInput,
  ContextPhase,
  ContextProvider,
  ContextProviderError,
  ContextSource,
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
 * Returns ONE `ContextSource`. The builder wraps it into a
 * `GenerationContext` — generation code never sees YouTube specifics.
 *
 * INVARIANTS
 * ----------
 * - Every error is translated to `ContextProviderError` with a
 *   friendly `userMessage`. No raw library exceptions escape.
 * - Every strategy attempt is recorded in the source's `provenance[]`.
 * - `canHandle` is cheap (URL regex). No network calls.
 * - Honours `AbortSignal`; throws `cancelled` on abort.
 * - Strategies know NOTHING about each other. The provider owns the
 *   fallback chain.
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
    const primary = (input.primary || '').trim();
    if (!primary) return false;
    return /youtu\.?be/.test(primary) || /^[A-Za-z0-9_-]{11}$/.test(primary);
  }

  async extract(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<ContextSource> {
    const videoId = requireYouTubeId(input.primary);

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    onPhase(CONTEXT_PHASES.PREPARING_CONTEXT);
    const meta = await fetchVideoMeta(videoId, signal);

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    const provenance: ContextSource['provenance'] = [];
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

      // Same user-facing label for every strategy. We never reveal
      // which one is running — that's an implementation detail.
      onPhase(CONTEXT_PHASES.UNDERSTANDING_MATERIAL);

      const t0 = Date.now();
      try {
        const result = await strategy.extract(videoId, signal, onPhase);

        const cleaned = this.cleaner.clean(result.lines);
        const transcriptHash = this.cleaner.hash(cleaned);

        provenance.push({
          strategy: strategy.name,
          outcome: 'success',
          durationMs: Date.now() - t0,
          note: result.language,
        });

        onPhase(CONTEXT_PHASES.UNDERSTANDING_MATERIAL);

        const content = cleaned.text;
        if (!content) {
          // Strategy claimed success but produced nothing usable.
          // Treat as unavailable and continue down the chain.
          provenance.push({
            strategy: strategy.name,
            outcome: 'unavailable',
            durationMs: Date.now() - t0,
            note: 'empty content after cleaning',
          });
          continue;
        }

        const source: ContextSource = {
          id: videoId,
          type: 'youtube',
          title: meta.title || `YouTube video ${videoId}`,
          content,
          metadata: {
            videoId,
            durationSec: meta.durationSec,
            author: meta.author,
            thumbnailUrl: meta.thumbnailUrl,
            language: result.language,
            transcriptHash,
            // Compact provenance for analytics without bloating the
            // document. The full per-strategy record lives in
            // `provenance` above; this is the at-a-glance summary.
            winningStrategy: strategy.name,
          },
          provenance,
          createdAt: new Date(),
        };

        return source;
      } catch (err) {
        if (signal.aborted) {
          throw new ContextProviderError(
            'Cancelled',
            'Generation cancelled.',
            'cancelled',
          );
        }
        if (!(err instanceof ContextProviderError)) {
          ileLog('error', 'context.strategy.unexpected_error', {
            strategy: strategy.name,
            error: (err as Error).message,
          });
          continue;
        }

        const durationMs = Date.now() - t0;

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

    // Every strategy returned `unavailable` — give the teacher a
    // friendly message. If the Whisper strategy recorded a
    // not_configured note, surface the install hint.
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
