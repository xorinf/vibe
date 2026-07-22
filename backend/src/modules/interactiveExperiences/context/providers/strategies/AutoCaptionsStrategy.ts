import { TranscriptStrategy, StrategyResult } from './Strategy.js';
import { TranscriptLine } from '../../TranscriptCleaner.js';
import { ContextProviderError, ContextPhase } from '../../types.js';
import {
  isUnavailableMessage,
  isUnsupportedMessage,
} from './captionErrors.js';

/**
 * Strategy 2 — YouTube auto-generated captions.
 *
 * Same library as creator captions, but we explicitly request the
 * auto-generated track by passing `lang` (the library picks the
 * ASR-generated track for languages where no upload exists).
 *
 * We try a small set of common languages in order. The list is
 * configurable via env (ILE_YT_AUTO_LANGS) so deployments in
 * non-English markets can adapt without code changes.
 */
export class AutoCaptionsStrategy implements TranscriptStrategy {
  readonly name = 'auto-captions';

  /**
   * Languages to try, in order. Override via env
   * `ILE_YT_AUTO_LANGS=es,fr,de` (comma-separated).
   */
  private readonly languages: string[];

  constructor() {
    const envLangs = process.env.ILE_YT_AUTO_LANGS;
    if (envLangs && envLangs.trim()) {
      this.languages = envLangs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      this.languages = ['en', 'en-US', 'en-GB', 'es', 'fr', 'de'];
    }
  }

  async extract(
    videoId: string,
    signal: AbortSignal,
    _onPhase: (phase: ContextPhase) => void,
  ): Promise<StrategyResult> {
    let mod: typeof import('youtube-transcript');
    try {
      mod = (await import('youtube-transcript' as string)) as typeof import('youtube-transcript');
    } catch (err) {
      throw new ContextProviderError(
        'youtube-transcript package not installed',
        'YouTube captions support is unavailable. Contact your administrator.',
        'transient',
        err,
      );
    }

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    const fetchTranscript = (mod as unknown as {
      default?: { fetchTranscript?: (...args: unknown[]) => Promise<unknown> };
      fetchTranscript?: (...args: unknown[]) => Promise<unknown>;
    }).fetchTranscript ?? (mod as unknown as {
      default: { fetchTranscript?: (...args: unknown[]) => Promise<unknown> };
    }).default?.fetchTranscript;

    if (typeof fetchTranscript !== 'function') {
      throw new ContextProviderError(
        'youtube-transcript.fetchTranscript is not a function',
        'YouTube captions support is unavailable.',
        'transient',
      );
    }

    const tried: string[] = [];
    let lastErr: unknown = null;

    for (const lang of this.languages) {
      if (signal.aborted) {
        throw new ContextProviderError(
          'Cancelled',
          'Generation cancelled.',
          'cancelled',
        );
      }
      tried.push(lang);
      try {
        const raw = (await fetchTranscript(videoId, { lang })) as Array<{
          text: string;
          offset: number;
          duration: number;
        }>;
        if (Array.isArray(raw) && raw.length > 0) {
          const lines: TranscriptLine[] = raw
            .filter((r) => r && typeof r.text === 'string')
            .map((r) => ({
              startSec: Math.max(0, Number(r.offset) || 0),
              text: String(r.text),
            }));
          if (lines.length > 0) {
            return { lines, language: lang };
          }
        }
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        // Unsupported video errors (private / region / age) — surface
        // them immediately rather than trying every language.
        if (isUnsupportedMessage(message)) {
          throw new ContextProviderError(
            `Video unsupported: ${message}`,
            'This video is not available for automatic captioning.',
            'unsupported',
            err,
          );
        }
        // Track and continue. Different languages can hit different
        // backend paths.
        lastErr = err;
      }
    }

    // No language worked. Decide between `unavailable` and `transient`.
    if (lastErr && !isUnavailableMessage((lastErr as Error).message ?? '')) {
      throw new ContextProviderError(
        `Auto captions failed for languages [${tried.join(', ')}]: ${(lastErr as Error).message}`,
        'We had trouble reaching YouTube. Try again in a moment.',
        'transient',
        lastErr,
      );
    }
    throw new ContextProviderError(
      `No auto captions in languages [${tried.join(', ')}]`,
      'No auto-generated captions are available for this video.',
      'unavailable',
      lastErr ?? undefined,
    );
  }
}
