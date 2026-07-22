import { TranscriptStrategy, StrategyResult } from './Strategy.js';
import { TranscriptLine } from '../../TranscriptCleaner.js';
import { ContextProviderError, ContextPhase } from '../../types.js';
import { isUnavailableMessage, isUnsupportedMessage } from './captionErrors.js';

/**
 * Strategy 1 — creator-uploaded captions via `youtube-transcript`.
 *
 * Why this is the preferred strategy:
 *   - Free, no API key, no rate limits to speak of.
 *   - High accuracy (creator-verified).
 *   - Works without yt-dlp, faster-whisper, or Python.
 *
 * How it works:
 *   `youtube-transcript` calls YouTube's public `timedtext` endpoint
 *   using the video's `INNERTUBE_API_KEY` extracted from the watch
 *   page HTML. If the creator uploaded a captions track the call
 *   returns the parsed lines.
 *
 * Failure modes:
 *   - No captions uploaded → `unavailable` → fall through to strategy 2.
 *   - Video is private/age-restricted → `unsupported` → do NOT fall
 *     through (creator captions would never exist for such a video).
 *   - Network / HTML shape changed → `transient` → fall through.
 *
 * NOTE: The library's `fetchTranscript` throws on any error and
 * returns `string[]` for `formatText`. We always call it WITHOUT
 * `formatText` so we get the typed `TranscriptResponse[]` shape, then
 * normalise to our `TranscriptLine` shape ourselves.
 */
export class CreatorCaptionsStrategy implements TranscriptStrategy {
  readonly name = 'creator-captions';

  async extract(
    videoId: string,
    signal: AbortSignal,
    _onPhase: (phase: ContextPhase) => void,
  ): Promise<StrategyResult> {
    let mod: typeof import('youtube-transcript');
    try {
      // Lazy require so an uninstalled package doesn't crash boot — the
      // provider's runtime detection will degrade gracefully. tsx + ts-node
      // both honour `require` for CJS modules.
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

    try {
      // The library's typing is loose; we cast through `unknown` to keep
      // ours strict without depending on the package's types staying
      // stable across versions.
      const fetchTranscript = (mod as unknown as {
        default?: { fetchTranscript?: (...args: unknown[]) => Promise<unknown> };
        fetchTranscript?: (...args: unknown[]) => Promise<unknown>;
      }).fetchTranscript ?? (mod as unknown as {
        default: { fetchTranscript?: (...args: unknown[]) => Promise<unknown> };
      }).default?.fetchTranscript;

      if (typeof fetchTranscript !== 'function') {
        throw new ContextProviderError(
          'youtube-transcript.fetchTranscript is not a function — package shape changed',
          'YouTube captions support is unavailable.',
          'transient',
        );
      }

      const raw = (await fetchTranscript(videoId)) as Array<{
        text: string;
        offset: number;
        duration: number;
      }>;

      if (!Array.isArray(raw) || raw.length === 0) {
        throw new ContextProviderError(
          'No creator captions available',
          'No creator captions available.',
          'unavailable',
        );
      }

      const lines: TranscriptLine[] = raw
        .filter((r) => r && typeof r.text === 'string')
        .map((r) => ({
          // The library returns offset in SECONDS. We pass it through
          // unchanged; TranscriptCleaner handles unit normalisation.
          startSec: Math.max(0, Number(r.offset) || 0),
          text: String(r.text),
        }));

      if (lines.length === 0) {
        throw new ContextProviderError(
          'Creator captions empty after normalisation',
          'No creator captions available.',
          'unavailable',
        );
      }

      return { lines, language: 'unknown' };
    } catch (err) {
      // Re-throw our own typed errors verbatim.
      if (err instanceof ContextProviderError) throw err;

      const message = (err as Error).message ?? String(err);

      // Map library error strings → typed ContextProviderError.
      if (isUnavailableMessage(message)) {
        throw new ContextProviderError(
          `No creator captions: ${message}`,
          'No creator captions available.',
          'unavailable',
          err,
        );
      }
      if (isUnsupportedMessage(message)) {
        throw new ContextProviderError(
          `Video unsupported: ${message}`,
          'This video is not available for automatic captioning.',
          'unsupported',
          err,
        );
      }

      throw new ContextProviderError(
        `youtube-transcript error: ${message}`,
        'We had trouble reaching YouTube. Try again in a moment.',
        'transient',
        err,
      );
    }
  }
}
