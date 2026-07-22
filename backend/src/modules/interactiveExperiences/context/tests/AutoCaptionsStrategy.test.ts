/**
 * Tests for AutoCaptionsStrategy — Strategy 2 of the YouTube fallback chain.
 *
 * The strategy iterates a configurable list of languages (env override or
 * the default list) and calls `youtube-transcript.fetchTranscript(id, {lang})`
 * for each, returning the FIRST language that yields non-empty lines.
 *
 * Important behavioural contracts we pin:
 *   - "unsupported" errors (private / region / age) short-circuit the loop
 *     and propagate immediately — we don't burn through every language
 *     when the video itself is blocked.
 *   - "unavailable" errors continue to the next language (different
 *     captions tracks can hit different backend paths).
 *   - When every language fails with unavailable-class messages → final
 *     `unavailable` ContextProviderError.
 *   - When every language fails with anything else → final `transient`.
 *   - Empty lines array from any language → continue to next.
 *   - `ILE_YT_AUTO_LANGS` env var controls the language list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('youtube-transcript', () => ({
  fetchTranscript: vi.fn(),
}));

import { AutoCaptionsStrategy } from '../providers/strategies/AutoCaptionsStrategy.js';
import { ContextProviderError } from '../types.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const youtubeTranscriptMock = await import('youtube-transcript');

const VIDEO_ID = 'dQw4w9WgXcQ';
const noopPhase = () => undefined;
const freshSignal = () => new AbortController().signal;

describe('AutoCaptionsStrategy', () => {
  beforeEach(() => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockReset();
    delete process.env.ILE_YT_AUTO_LANGS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ILE_YT_AUTO_LANGS;
  });

  // ─── happy path ───────────────────────────────────────────────────

  it('returns the first language that yields captions', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript)
      .mockRejectedValueOnce(new Error('No transcripts are available')) // en
      .mockRejectedValueOnce(new Error('No transcripts are available')) // en-US
      .mockResolvedValueOnce([
        // en-GB succeeds
        { text: 'Auto line', offset: 0, duration: 2 },
        { text: 'Second line', offset: 2, duration: 3 },
      ]);

    const result = await new AutoCaptionsStrategy().extract(
      VIDEO_ID,
      freshSignal(),
      noopPhase,
    );

    expect(result.language).toBe('en-GB');
    expect(result.lines).toHaveLength(2);
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenCalledTimes(3);
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenNthCalledWith(
      1,
      VIDEO_ID,
      { lang: 'en' },
    );
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenNthCalledWith(
      2,
      VIDEO_ID,
      { lang: 'en-US' },
    );
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenNthCalledWith(
      3,
      VIDEO_ID,
      { lang: 'en-GB' },
    );
  });

  it('uses the default language list when ILE_YT_AUTO_LANGS is unset', async () => {
    // Every language rejects with an unavailable-class message so the
    // loop iterates through ALL the defaults before throwing.
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('No transcripts are available for this video'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const langs = vi
      .mocked(youtubeTranscriptMock.fetchTranscript)
      .mock.calls.map((c) => (c[1] as { lang: string }).lang);
    expect(langs).toEqual(['en', 'en-US', 'en-GB', 'es', 'fr', 'de']);
  });

  // ─── env override ─────────────────────────────────────────────────

  it('honours ILE_YT_AUTO_LANGS env var override', async () => {
    process.env.ILE_YT_AUTO_LANGS = 'ja,ko,zh-Hans';
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('No transcripts are available for this video'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const langs = vi
      .mocked(youtubeTranscriptMock.fetchTranscript)
      .mock.calls.map((c) => (c[1] as { lang: string }).lang);
    expect(langs).toEqual(['ja', 'ko', 'zh-Hans']);
  });

  it('filters out empty entries from the env override', async () => {
    process.env.ILE_YT_AUTO_LANGS = ' ja , , ko , ';
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('No transcripts are available for this video'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const langs = vi
      .mocked(youtubeTranscriptMock.fetchTranscript)
      .mock.calls.map((c) => (c[1] as { lang: string }).lang);
    expect(langs).toEqual(['ja', 'ko']);
  });

  // ─── unsupported short-circuits ───────────────────────────────────

  it('propagates unsupported immediately, without trying later languages', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValueOnce(
      new Error('Private video. Sign in to confirm your age.'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({
      kind: 'unsupported',
      userMessage: 'This video is not available for automatic captioning.',
    });

    // Only one language tried.
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it('propagates "not available in your country" as unsupported', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('The uploader has not made this video available in your country.'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unsupported' });

    // Short-circuits on the first language.
    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it('propagates "age-restricted" as unsupported', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValueOnce(
      new Error('This video is age-restricted'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unsupported' });

    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenCalledTimes(1);
  });

  // ─── all-unavailable ──────────────────────────────────────────────

  it('throws unavailable when every language returns an unavailable-class error', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('No transcripts are available for this video'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      userMessage:
        'No auto-generated captions are available for this video.',
    });
  });

  // ─── all-transient ────────────────────────────────────────────────

  it('throws transient when every language fails with a non-classified error', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(
      new Error('fetch failed: ECONNRESET'),
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({
      kind: 'transient',
      userMessage: 'We had trouble reaching YouTube. Try again in a moment.',
    });
  });

  it('keeps the last error accessible via .cause on the transient throw', async () => {
    const original = new Error('socket hang up');
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockRejectedValue(original);

    const err = await new AutoCaptionsStrategy()
      .extract(VIDEO_ID, freshSignal(), noopPhase)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ContextProviderError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((err as any).cause).toBe(original);
  });

  // ─── empty arrays continue ────────────────────────────────────────

  it('continues to the next language when one returns an empty array', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript)
      .mockResolvedValueOnce([]) // en — empty
      .mockResolvedValueOnce([]) // en-US — empty
      .mockResolvedValueOnce([
        // en-GB succeeds
        { text: 'Finally', offset: 0, duration: 1 },
      ]);

    const result = await new AutoCaptionsStrategy().extract(
      VIDEO_ID,
      freshSignal(),
      noopPhase,
    );

    expect(result.language).toBe('en-GB');
    expect(result.lines[0]?.text).toBe('Finally');
  });

  it('continues to the next language when one returns items with no valid text', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript)
      .mockResolvedValueOnce([
        // en — every item has a non-string text → empty after filter
        { text: 42 as unknown as string, offset: 0, duration: 1 },
      ])
      .mockResolvedValueOnce([
        { text: 'Auto line', offset: 0, duration: 2 },
      ]);

    const result = await new AutoCaptionsStrategy().extract(
      VIDEO_ID,
      freshSignal(),
      noopPhase,
    );

    expect(result.language).toBe('en-US');
    expect(result.lines).toHaveLength(1);
  });

  // ─── mixed errors: per-lang unsupported bubbles up ────────────────

  it('surfaces unsupported even when earlier languages returned unavailable', async () => {
    vi.mocked(youtubeTranscriptMock.fetchTranscript)
      .mockRejectedValueOnce(new Error('No transcripts are available')) // en: unavailable
      .mockRejectedValueOnce(new Error('Private video')); // en-US: unsupported

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
    ).rejects.toMatchObject({ kind: 'unsupported' });

    expect(youtubeTranscriptMock.fetchTranscript).toHaveBeenCalledTimes(2);
  });

  // ─── pre-aborted signal ───────────────────────────────────────────

  it('throws cancelled synchronously when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, ac.signal, noopPhase),
    ).rejects.toMatchObject({
      kind: 'cancelled',
      userMessage: 'Generation cancelled.',
    });

    expect(youtubeTranscriptMock.fetchTranscript).not.toHaveBeenCalled();
  });

  it('throws cancelled when the signal aborts mid-loop', async () => {
    const ac = new AbortController();
    vi.mocked(youtubeTranscriptMock.fetchTranscript).mockImplementation(
      async () => {
        ac.abort();
        throw new Error('No transcripts are available');
      },
    );

    await expect(
      new AutoCaptionsStrategy().extract(VIDEO_ID, ac.signal, noopPhase),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  // ─── package shape change ─────────────────────────────────────────

  it('throws transient when fetchTranscript is missing from the module', async () => {
    const ytMod = youtubeTranscriptMock as unknown as Record<string | symbol, unknown>;
    Object.defineProperty(ytMod, 'fetchTranscript', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(ytMod, 'default', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    });

    try {
      await expect(
        new AutoCaptionsStrategy().extract(VIDEO_ID, freshSignal(), noopPhase),
      ).rejects.toMatchObject({
        kind: 'transient',
        userMessage: 'YouTube captions support is unavailable.',
      });
    } finally {
      Object.defineProperty(ytMod, 'fetchTranscript', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: vi.fn(),
      });
      Object.defineProperty(ytMod, 'default', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
    }
  });
});
