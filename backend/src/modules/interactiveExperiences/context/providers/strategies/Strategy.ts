import { TranscriptLine } from '../../TranscriptCleaner.js';
import { ContextPhase } from '../../types.js';

/**
 * Result of a single strategy attempt.
 */
export interface StrategyResult {
  /** Lines preserved for chapter extraction downstream. */
  lines: TranscriptLine[];
  /** Human-readable language identifier (e.g. 'en', 'es'). */
  language: string;
}

/**
 * Single strategy in the YouTube provider's fallback chain. Strategies
 * are stateless and side-effect-free; the provider owns ordering and
 * bookkeeping.
 *
 * Throws `ContextProviderError` on any failure:
 *   - `unavailable`: this strategy isn't applicable (e.g. no captions
 *     in any tried language); caller should fall through to next.
 *   - `unsupported`: video-level block (private, region, age-restricted);
 *     caller should NOT fall through — these are user-fixable problems.
 *   - `transient`: network blip; caller MAY retry, then fall through.
 *   - `cancelled`: caller aborted; propagate up.
 */
export interface TranscriptStrategy {
  /** Stable id used in logs and provenance. */
  readonly name: string;

  /**
   * Try to extract a transcript for the given video id.
   * MUST honour `signal`. MUST translate every raw error into a
   * `ContextProviderError`.
   */
  extract(
    videoId: string,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<StrategyResult>;
}
