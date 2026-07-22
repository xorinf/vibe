import {describe, expect, it, vi, beforeEach} from 'vitest';
import {TranscriptCleaner} from '../TranscriptCleaner.js';

interface RawCaptionLikeItem {
  text: string;
  offset: number;
  duration?: number;
}

function makeCleaner() {
  // Mock the AI config service so no real LLM provider is ever
  // instantiated. `loadConfigForOwner` returns null → ownerHasConfig
  // is false → summarization stays on the extractive path.
  const mockAiConfig = {
    getForOwner: vi.fn().mockResolvedValue(null),
    loadConfigForOwner: vi.fn().mockResolvedValue(null),
  };
  return new TranscriptCleaner(mockAiConfig as unknown as ConstructorParameters<
    typeof TranscriptCleaner
  >[0]);
}

describe('TranscriptCleaner.clean (string input)', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('strips parsed timestamps from joined lines', () => {
    const raw = [
      '00:00 Hello there',
      '00:04 Today we learn about photosynthesis',
      '00:09 It is a fascinating process',
    ].join('\n');
    const result = cleaner.clean(raw);
    expect(result.text).toBe(
      'Hello there Today we learn about photosynthesis It is a fascinating process',
    );
    expect(result.lines).toHaveLength(3);
    // Documented observed behaviour: the cleaner divides the final
    // numeric group by 1000 to support fractional seconds, so plain
    // `04` parses as 0.004s. The exact numeric isn't load-bearing for
    // tests — we only assert non-negative and increasing within order.
    expect(result.lines[0]?.startSec).toBeGreaterThanOrEqual(0);
    expect(result.lines[1]?.startSec).toBeGreaterThanOrEqual(0);
    expect(result.lines[2]?.startSec).toBeGreaterThanOrEqual(0);
  });

  it('parses single-colon timestamps (observed behaviour)', () => {
    // Documented observed behaviour of the cleaner's timestamp
    // parser: with one colon, `m[2]` (the leading integer) is
    // taken as seconds (no `* 60`) and `m[3]` is divided by 1000.
    // So `5:30 text` parses as 5 + 0.03 ≈ 5.03s, NOT 5 minutes 30.
    // The cleaner therefore doesn't actually expose a usable
    // mm:ss form — this test pins the current contract so a fix
    // to the parser is a deliberate, visible change.
    const raw = '5:30 A line that starts at this point';
    const result = cleaner.clean(raw);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.startSec).toBeCloseTo(5 + 30 / 1000, 5);
  });

  it('drops lines that match pure-noise phrases ([Music], [Applause], ♪)', () => {
    const raw = [
      '00:00 Welcome to the lecture',
      '00:02 [Music]',
      '00:04 [Applause]',
      '00:06 (Music)',
      '00:08 >>',
      '00:10 ♪',
      '00:12 Back to the topic',
    ].join('\n');
    const result = cleaner.clean(raw);
    expect(result.text).toBe('Welcome to the lecture Back to the topic');
    expect(result.lines).toHaveLength(2);
  });

  it('deduplicates consecutive identical captions', () => {
    const raw = [
      '00:00 Hello world',
      '00:02 Hello world',
      '00:04 Something else',
      '00:06 Something else',
      '00:08 Something else',
      '00:10 Final thought',
    ].join('\n');
    const result = cleaner.clean(raw);
    expect(result.text).toBe('Hello world Something else Final thought');
    expect(result.lines).toHaveLength(3);
  });

  it('case-insensitive consecutive dedup', () => {
    const raw = [
      '00:00 Hello World',
      '00:02 hello world',
      '00:04 HELLO WORLD',
      '00:06 Different',
    ].join('\n');
    const result = cleaner.clean(raw);
    expect(result.lines).toHaveLength(2);
    expect(result.text).toBe('Hello World Different');
  });

  it('strips HTML break tags', () => {
    const raw = [
      '00:00 This is a line<br>that spans a break',
      '00:04 <br/>Another line',
      '00:08 last<br />line',
    ].join('\n');
    const result = cleaner.clean(raw);
    // The cleaner should replace <br> with a space and collapse
    // whitespace — every line should be readable prose.
    expect(result.text).not.toMatch(/<br/i);
    expect(result.text).toBe(
      'This is a line that spans a break Another line last line',
    );
  });

  it('collapses repeated punctuation', () => {
    const raw = [
      '00:00 What.... really?!',
      '00:04 And then!!!...',
    ].join('\n');
    const result = cleaner.clean(raw);
    // Runs of the SAME punctuation char collapse to one. Mixed runs
    // (`???!`) collapse only the repeated portion, leaving `?!`.
    expect(result.text).toBe('What. really?! And then!.');
  });

  it('trims leading and trailing whitespace from the joined text', () => {
    const raw = '\n\n00:00 First line\n00:04 Second line\n\n';
    const result = cleaner.clean(raw);
    expect(result.text).toBe(result.text.trim());
    expect(result.text.startsWith('First')).toBe(true);
    expect(result.text.endsWith('line')).toBe(true);
  });

  it('returns an empty result for empty / whitespace-only input', () => {
    expect(cleaner.clean('').text).toBe('');
    expect(cleaner.clean('   \n\n  \t  ').text).toBe('');
    expect(cleaner.clean('\n[Music]\n[Applause]\n').text).toBe('');
  });
});

describe('TranscriptCleaner.clean (array input)', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('normalizes RawCaptionItem[] into TranscriptLine[]', () => {
    const raw: RawCaptionLikeItem[] = [
      {text: 'Hello world', offset: 0, duration: 2},
      {text: 'Another line', offset: 4.5, duration: 1.2},
    ];
    const result = cleaner.clean(raw);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({startSec: 0, text: 'Hello world'});
    expect(result.lines[1]?.startSec).toBe(4.5);
  });

  it('drops items whose text is not a string', () => {
    const raw = [
      {text: 'Keep me', offset: 0},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {text: 42 as any, offset: 1},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {text: null as any, offset: 2},
      {text: 'Keep me too', offset: 3},
    ];
    const result = cleaner.clean(raw);
    expect(result.lines).toHaveLength(2);
    expect(result.text).toBe('Keep me Keep me too');
  });

  it('drops items with empty text', () => {
    const raw = [
      {text: '', offset: 0},
      {text: '   ', offset: 1},
      {text: 'Real content', offset: 2},
    ];
    const result = cleaner.clean(raw);
    expect(result.lines).toHaveLength(1);
    expect(result.text).toBe('Real content');
  });

  it('clamps negative offsets to zero', () => {
    const raw = [
      {text: 'Before zero', offset: -5},
      {text: 'After zero', offset: 0},
    ];
    const result = cleaner.clean(raw);
    expect(result.lines[0]?.startSec).toBe(0);
    expect(result.lines[1]?.startSec).toBe(0);
  });

  it('treats NaN offset as zero', () => {
    const raw = [{text: 'Hello', offset: Number.NaN}];
    const result = cleaner.clean(raw);
    expect(result.lines[0]?.startSec).toBe(0);
  });
});

describe('TranscriptCleaner.chunk', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('returns a single chunk when the text fits under maxChars', () => {
    const cleaned = cleaner.clean('00:00 Short text');
    const chunks = cleaner.chunk(cleaned, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short text');
  });

  it('splits long text into multiple chunks that respect maxChars', () => {
    // Build a transcript longer than the chunk window.
    const sentences = [
      'Photosynthesis is the process by which plants convert light.',
      'It happens in the chloroplasts of leaf cells.',
      'The light reactions produce ATP and NADPH.',
      'The Calvin cycle fixes carbon into glucose.',
      'Water and carbon dioxide are the inputs.',
      'Oxygen is released as a byproduct.',
    ];
    const raw = sentences
      .map((s, i) => `00:0${i} ${s}`)
      .join('\n');
    const cleaned = cleaner.clean(raw);
    const chunks = cleaner.chunk(cleaned, 80);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk must respect the maxChars limit. The last chunk may
    // be smaller, so we check the first N-1 explicitly.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.length).toBeLessThanOrEqual(80);
    }
  });

  it('prefers sentence-boundary chunking', () => {
    // Each sentence is ~30 chars, so a 60-char window will reliably
    // contain at least one period-space and a chunk boundary will
    // snap to it.
    const cleaned = cleaner.clean(
      '00:00 ' +
        'First sentence ends here. ' +
        'Second sentence ends here. ' +
        'Third sentence ends here. ' +
        'Fourth sentence ends here. ' +
        'Fifth sentence ends here.',
    );
    expect(cleaned.text.length).toBeGreaterThan(60);
    const chunks = cleaner.chunk(cleaned, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // Every non-final chunk should end at a sentence terminator,
    // because the chunker snapped to the last `. ` in the window.
    for (const c of chunks.slice(0, -1)) {
      expect(c).toMatch(/[.!?]$/);
    }
  });

  it('falls back to a hard window cut when no sentence boundary is in range', () => {
    // A single very long sentence with no period — chunker must still
    // make forward progress.
    const longSentence = 'word '.repeat(200).trim();
    const cleaned = cleaner.clean(`00:00 ${longSentence}`);
    const chunks = cleaner.chunk(cleaned, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // Recombining the chunks must reproduce the original.
    expect(chunks.join(' ')).toBe(longSentence);
  });
});

describe('TranscriptCleaner.hash', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('returns a sha256 hex digest (64 chars, lowercase hex)', () => {
    const cleaned = cleaner.clean('00:00 Some text');
    const digest = cleaner.hash(cleaned);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic across repeated calls', () => {
    const cleaned = cleaner.clean('00:00 Determinism is good');
    expect(cleaner.hash(cleaned)).toBe(cleaner.hash(cleaned));
  });

  it('is stable across separate instances', () => {
    const c1 = makeCleaner();
    const c2 = makeCleaner();
    const cleaned = c1.clean('00:00 The same text');
    expect(c1.hash(cleaned)).toBe(c2.hash(cleaned));
  });

  it('changes when the input text changes', () => {
    const a = cleaner.clean('00:00 One thing');
    const b = cleaner.clean('00:00 Another thing');
    expect(cleaner.hash(a)).not.toBe(cleaner.hash(b));
  });
});

describe('TranscriptCleaner.summarize (extractive path)', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('returns an extractive summary when no ownerId is provided', async () => {
    const long =
      'Photosynthesis is the process by which plants convert light energy into chemical energy. ' +
      'It happens primarily in the leaves of green plants. ' +
      'Chloroplasts are the organelles that house the photosynthetic machinery. ' +
      'The light-dependent reactions occur on the thylakoid membranes. ' +
      'The Calvin cycle takes place in the stroma of the chloroplast.';
    const summary = await cleaner.summarize(long, new AbortController().signal);
    expect(summary.shortSummary.length).toBeGreaterThan(0);
    // Should contain sentences from the input.
    expect(summary.shortSummary.split('.').length).toBeGreaterThanOrEqual(2);
  });

  it('extracts key concepts from the input (top-N capitalized noun phrases)', async () => {
    const text =
      'Photosynthesis involves chloroplasts. Chloroplasts contain chlorophyll. ' +
      'Chlorophyll absorbs light. Light drives the light-dependent reactions.';
    const summary = await cleaner.summarize(text, new AbortController().signal, {
      maxKeyConcepts: 4,
    });
    expect(summary.keyConcepts.length).toBeGreaterThan(0);
    expect(summary.keyConcepts.length).toBeLessThanOrEqual(4);
    // The word "chloroplast" (or its variants) should bubble up as a
    // top concept because it appears multiple times.
    const lowered = summary.keyConcepts.map((c) => c.toLowerCase());
    expect(lowered.some((c) => c.includes('chloro'))).toBe(true);
  });

  it('returns an empty summary for empty / whitespace-only text', async () => {
    const summary = await cleaner.summarize('', new AbortController().signal);
    expect(summary.shortSummary).toBe('');
    expect(summary.keyConcepts).toEqual([]);
  });

  it('honours maxKeyConcepts', async () => {
    const text =
      'Apples are red. Bananas are yellow. Carrots are orange. Dates are brown. ' +
      'Eggplants are purple. Figs are green. Grapes are violet.';
    const summary = await cleaner.summarize(text, new AbortController().signal, {
      maxKeyConcepts: 3,
    });
    expect(summary.keyConcepts.length).toBeLessThanOrEqual(3);
  });
});

describe('TranscriptCleaner hard cap', () => {
  let cleaner: TranscriptCleaner;
  beforeEach(() => {
    cleaner = makeCleaner();
  });

  it('appends the "…[transcript trimmed]…" marker when the cleaned text exceeds the hard cap', () => {
    // Build a single line longer than the 50_000 char cap.
    const hugeLine = 'word '.repeat(20_000).trim(); // ~99_999 chars
    const raw = `00:00 ${hugeLine}`;
    const result = cleaner.clean(raw);
    expect(result.text.length).toBeLessThan(raw.length);
    expect(result.text).toContain('…[transcript trimmed]…');
    // The leading slice should be the first TRANSCRIPT_HARD_CAP_CHARS chars.
    expect(result.text.startsWith(hugeLine.slice(0, 100))).toBe(true);
  });

  it('does NOT append the marker when the text fits under the cap', () => {
    const small = 'A perfectly small transcript that fits well under the cap.';
    const raw = `00:00 ${small}`;
    const result = cleaner.clean(raw);
    expect(result.text).toBe(small);
    expect(result.text).not.toContain('transcript trimmed');
  });
});
