import { injectable, inject } from 'inversify';
import { createHash } from 'crypto';
import { ILE_TYPES } from '../types.js';
import { IleAiConfigService } from '../services/IleAiConfigService.js';
import {
  ChatStream,
  ChatStreamRequest,
  classifyUpstreamError,
  asProviderError,
  StreamChunk,
} from '../services/providers/types.js';
import { createProvider } from '../services/providers/index.js';
import { ileLog } from '../services/observability.js';
import { ContextSummary } from './types.js';

/**
 * A single cleaned line with its (approximate) start timestamp.
 */
export interface TranscriptLine {
  startSec: number;
  text: string;
}

/**
 * Raw caption item shape from `youtube-transcript`. Defined here as a
 * separate type so the cleaner doesn't depend on the package's shape
 * staying stable.
 */
interface RawCaptionItem {
  text: string;
  /** Offset in seconds from start of video (NOT milliseconds). */
  offset: number;
  duration?: number;
}

/**
 * Result of `clean()`. The text is the joined prose; the lines array
 * preserves the per-caption timestamps for downstream chapter extraction.
 */
export interface CleanedTranscript {
  text: string;
  lines: TranscriptLine[];
}

/**
 * Hard cap on transcript size we'll feed into the LLM. 50k chars is
 * ~12.5k tokens — generous for most educational videos, bounded for
 * cost. Beyond this, we trim with a "…[trimmed]…" marker so the model
 * still understands the document is longer than what it sees.
 */
const TRANSCRIPT_HARD_CAP_CHARS = 50_000;

/**
 * Below this threshold we skip LLM summarization and use the extractive
 * path. Saves tokens and latency for short videos.
 */
const SUMMARIZE_LLM_THRESHOLD_CHARS = 1_500;

/**
 * Number of leading chunks to fetch the concept list from. We use the
 * first chunk because in educational videos the topic is announced
 * early; the LLM only needs a window, not the full document.
 */
const CONCEPT_EXTRACT_CHARS = 8_000;

/**
 * Default chunk size for chunk() — large enough to keep paragraph
 * context, small enough for clean sliding windows.
 */
const DEFAULT_CHUNK_CHARS = 4_000;

/**
 * Common YouTube auto-caption artifacts we strip during normalization.
 * The list is intentionally tiny — we don't try to be a general text
 * cleaner, only to undo the specific patterns YouTube produces.
 */
const DUPLICATE_PHRASES = [
  '[Music]',
  '[Applause]',
  '[Laughter]',
  '(Music)',
  '(Applause)',
  '(Laughter)',
  '>>',
  '♪',
];

/**
 * Pure transcript utilities + an optional LLM-backed summarization.
 *
 * Why a separate module:
 *   - Other transcript-shaped providers (audio, uploaded video) will
 *     reuse it.
 *   - Pure functions are trivially testable without mocking yt-dlp.
 *   - Owns its own LLM call via the existing `IleAiConfigService` —
 *     we re-use the owner's configured provider + model + key. No
 *     separate AI config; cost lands on the same place teachers
 *     already understand.
 *
 * If the owner has no AI config, `summarize()` returns the
 * extractive fallback (top sentences by length × position weight).
 * The UI never sees a different shape either way.
 */
@injectable()
export class TranscriptCleaner {
  constructor(
    @inject(ILE_TYPES.IleAiConfigService)
    private readonly aiConfig: IleAiConfigService,
  ) {}

  /**
   * Normalize a raw YouTube transcript into clean prose.
   *
   * Accepts BOTH:
   *   - youtube-transcript's array shape: `[{ text, offset, duration }]`
   *   - the joined-text shape: `"00:00 Hello\n00:04 Today we learn..."`
   *
   * Returns cleaned prose plus a per-line timestamp array for chapter
   * extraction. Empty/whitespace-only entries are dropped.
   */
  /**
   * Accept either the youtube-transcript `RawCaptionItem[]` shape or
   * our internal `TranscriptLine[]` shape. Both carry a start time and
   * a text body; we normalise both to `TranscriptLine[]`.
   */
  clean(raw: string | RawCaptionItem[] | TranscriptLine[]): CleanedTranscript {
    const lines: TranscriptLine[] = [];

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item.text !== 'string') continue;
        const cleaned = normalizeLine(item.text);
        if (!cleaned) continue;
        // Discriminate by which time field is present. YouTube's
        // library returns `offset` (seconds); our internal strategies
        // use `startSec`. We pass either through unchanged.
        const startSec =
          typeof (item as RawCaptionItem).offset === 'number'
            ? Math.max(0, Number((item as RawCaptionItem).offset) || 0)
            : Math.max(0, Number((item as TranscriptLine).startSec) || 0);
        lines.push({ startSec, text: cleaned });
      }
    } else if (typeof raw === 'string') {
      // Parse the joined-text shape: "00:00 Hello\n00:04 Today..."
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.*)$/);
        if (m) {
          const startSec =
            (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) + Number(m[3]) / 1000;
          const cleaned = normalizeLine(m[4]);
          if (!cleaned) continue;
          lines.push({ startSec, text: cleaned });
        } else {
          const cleaned = normalizeLine(trimmed);
          if (!cleaned) continue;
          lines.push({ startSec: 0, text: cleaned });
        }
      }
    }

    // Drop near-duplicate consecutive captions — YouTube auto-captions
    // emit the same phrase multiple times when the speaker repeats or
    // the ASR model oscillates.
    const deduped: TranscriptLine[] = [];
    for (const ln of lines) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text.toLowerCase() === ln.text.toLowerCase()) {
        continue;
      }
      deduped.push(ln);
    }

    const text = deduped.map((l) => l.text).join(' ');
    const trimmed = maybeTrim(text);
    return { text: trimmed, lines: deduped };
  }

  /**
   * Semantic chunking: split the cleaned prose into windows of roughly
   * `maxChars`. Chunks respect sentence boundaries when possible.
   *
   * No LLM call here — pure structural split. The summarizer may run
   * on each chunk in parallel.
   */
  chunk(cleaned: CleanedTranscript, maxChars = DEFAULT_CHUNK_CHARS): string[] {
    const text = cleaned.text;
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      let end = Math.min(text.length, cursor + maxChars);
      if (end < text.length) {
        // Back off to the nearest sentence boundary (. ! ? followed by space).
        const window = text.slice(cursor, end);
        const boundary = Math.max(
          window.lastIndexOf('. '),
          window.lastIndexOf('! '),
          window.lastIndexOf('? '),
        );
        if (boundary > maxChars * 0.5) {
          end = cursor + boundary + 1;
        }
      }
      chunks.push(text.slice(cursor, end).trim());
      cursor = end;
    }
    return chunks;
  }

  /**
   * Produce a `ContextSummary`. When the owner has an AI config and
   * the text is long enough to justify a real call, use the configured
   * provider. Otherwise fall back to extractive heuristics.
   *
   * Honors `signal` — aborts the LLM call cleanly when the teacher
   * cancels.
   */
  async summarize(
    text: string,
    signal: AbortSignal,
    options: {
      ownerId?: string;
      useLLM?: boolean;
      maxKeyConcepts?: number;
    } = {},
  ): Promise<ContextSummary> {
    const maxKeyConcepts = options.maxKeyConcepts ?? 6;

    if (!options.ownerId) {
      // No owner → no config lookup. Use extractive.
      return extractiveSummary(text, maxKeyConcepts);
    }

    const cfg = await this.aiConfig.getForOwner(options.ownerId).catch(() => null);
    const ownerHasConfig = Boolean(
      cfg && (cfg as { hasApiKey?: boolean }).hasApiKey,
    );

    const useLLM =
      options.useLLM !== false &&
      ownerHasConfig &&
      text.length >= SUMMARIZE_LLM_THRESHOLD_CHARS;

    if (!useLLM) {
      return extractiveSummary(text, maxKeyConcepts);
    }

    // Resolve the provider from the owner's full (decrypted) config.
    // `makeClientForOwner` is intentionally private to the service — we
    // call into it via a dedicated helper that the service exposes.
    const stream = await this.makeStreamForOwner(options.ownerId);

    try {
      return await llmSummary(stream, text, signal, maxKeyConcepts);
    } catch (err) {
      // LLM failed (timeout, rate limit, transient). Fall back to
      // extractive — never propagate. The teacher still gets a useful
      // context; the LLM problem is logged.
      ileLog('warn', 'context.summary.llm_failed', {
        error: (err as Error).message,
        textLength: text.length,
      });
      return extractiveSummary(text, maxKeyConcepts);
    }
  }

  /**
   * SHA-256 of the cleaned transcript text. Used as the future cache
   * key — and persisted on the experience document so we can tell
   * whether two experiences were generated from the same source
   * without storing the raw text.
   */
  hash(cleaned: CleanedTranscript): string {
    return createHash('sha256').update(cleaned.text).digest('hex');
  }

  /**
   * Make a streaming client from the owner's saved AI config. Private
   * helper — calls into IleAiConfigService for the full config (key
   * included) and wraps it in a `ChatStream` interface.
   *
   * Returns `null` if the owner has no config (caller falls back to
   * extractive).
   */
  private async makeStreamForOwner(ownerId: string): Promise<ChatStream | null> {
    const full = await this.aiConfig.loadConfigForOwner(ownerId).catch(() => null);
    if (!full || !full.apiKey) return null;
    const provider = createProvider(full);
    return provider;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Strip artifacts from a single caption line. Returns empty string if
 * the line is pure noise (e.g. only "[Music]").
 */
function normalizeLine(text: string): string {
  if (!text) return '';
  let t = text.trim();
  if (!t) return '';

  // Drop pure-duplicate-phrase lines.
  for (const phrase of DUPLICATE_PHRASES) {
    if (t === phrase) return '';
  }

  // Strip HTML break tags from auto-captions.
  t = t.replace(/<br\s*\/?>(\s*)/gi, ' ');

  // Collapse repeated punctuation ("....." → ".")
  t = t.replace(/([.!?])\1+/g, '$1');

  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

/**
 * Trim to `TRANSCRIPT_HARD_CAP_CHARS` with a marker so the model
 * understands the document was longer than what it sees.
 */
function maybeTrim(text: string): string {
  if (text.length <= TRANSCRIPT_HARD_CAP_CHARS) return text;
  return text.slice(0, TRANSCRIPT_HARD_CAP_CHARS) + ' …[transcript trimmed]…';
}

/**
 * Sentence splitter that handles common abbreviations without going
 * full NLP. Good enough for scoring + summarization heuristics.
 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Extractive summary — no LLM call. Scores sentences by length ×
 * position weight (early sentences matter more for topic intro).
 * Used as the fallback when the owner has no AI config or when the
 * LLM call fails.
 */
function extractiveSummary(
  text: string,
  maxKeyConcepts: number,
): ContextSummary {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return {
      shortSummary: '',
      keyConcepts: [],
      learningObjectives: [],
      misconceptions: [],
      interactiveOpportunities: [],
    };
  }

  // Score each sentence by length × position decay.
  const scored = sentences.map((s, idx) => {
    const positionWeight = 1 / (1 + idx * 0.02);
    const lengthScore = Math.min(1, s.length / 200);
    const alpha = 0.5;
    return { s, score: alpha * lengthScore + (1 - alpha) * positionWeight };
  });

  scored.sort((a, b) => b.score - a.score);

  const shortSummary = scored
    .slice(0, 3)
    .map((x) => x.s)
    .join(' ');

  // Concepts — capitalized noun phrases + repeated important words.
  const wordFreq = new Map<string, number>();
  const stopwords = new Set([
    'the', 'and', 'but', 'for', 'with', 'this', 'that', 'you', 'your',
    'have', 'has', 'had', 'are', 'was', 'were', 'will', 'would', 'could',
    'should', 'from', 'into', 'about', 'over', 'under', 'they', 'them',
    'their', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'not',
    'can', 'all', 'any', 'some', 'than', 'then', 'just', 'like', 'very',
  ]);
  const wordRe = /\b[A-Za-z][a-z]{2,}\b/g;
  for (const s of sentences) {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(s)) !== null) {
      const w = m[0].toLowerCase();
      if (stopwords.has(w)) continue;
      if (seen.has(w)) continue; // cap one occurrence per sentence
      seen.add(w);
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }
  }
  const keyConcepts = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeyConcepts)
    .map(([w]) => titleCase(w));

  return {
    shortSummary,
    keyConcepts,
    learningObjectives: [],
    misconceptions: [],
    interactiveOpportunities: [],
  };
}

/**
 * LLM-backed summary. Streams a structured JSON response from the
 * owner's configured provider, parses it, and returns the result.
 * Falls back to extractive on parse/stream failure.
 */
async function llmSummary(
  stream: ChatStream,
  text: string,
  signal: AbortSignal,
  maxKeyConcepts: number,
): Promise<ContextSummary> {
  // Use only the first CONCEPT_EXTRACT_CHARS for the concept list —
  // in educational videos the topic is announced early and this
  // saves substantial tokens.
  const windowText =
    text.length > CONCEPT_EXTRACT_CHARS
      ? text.slice(0, CONCEPT_EXTRACT_CHARS) + ' …[rest of transcript omitted for summarization]…'
      : text;

  const system = `You are an educational content analyzer. Given a transcript, produce a structured JSON summary.
Output rules:
- Emit ONLY a single JSON object, no prose before or after, no markdown fences.
- Keys: "shortSummary" (string, <= 600 chars), "keyConcepts" (array of <= ${maxKeyConcepts} short noun phrases), "learningObjectives" (array of 2-4 strings), "misconceptions" (array of 0-3 strings), "interactiveOpportunities" (array of 1-4 strings describing ways to engage the learner).
- All values must be in the same language as the transcript.`;

  const req: ChatStreamRequest = {
    system,
    messages: [{ role: 'user', content: windowText }],
    temperature: 0.2,
    maxTokens: 1500,
  };

  let acc = '';
  for await (const chunk of stream.stream({ ...req, signal })) {
    if (signal.aborted) break;
    if (chunk.kind === 'text') acc += chunk.delta;
  }

  return parseSummaryJson(acc) ?? extractiveSummary(text, maxKeyConcepts);
}

/**
 * Parse the streamed LLM output as JSON. Tolerant of stray markdown
 * fences and surrounding prose — looks for the first `{` and last `}`.
 */
function parseSummaryJson(raw: string): ContextSummary | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip ```json fences if present.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // Find first { and last }.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const json = s.slice(start, end + 1);
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      shortSummary:
        typeof parsed.shortSummary === 'string' ? parsed.shortSummary : '',
      keyConcepts: Array.isArray(parsed.keyConcepts)
        ? parsed.keyConcepts.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      learningObjectives: Array.isArray(parsed.learningObjectives)
        ? parsed.learningObjectives.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      misconceptions: Array.isArray(parsed.misconceptions)
        ? parsed.misconceptions.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      interactiveOpportunities: Array.isArray(parsed.interactiveOpportunities)
        ? parsed.interactiveOpportunities.filter(
            (x: unknown): x is string => typeof x === 'string',
          )
        : [],
    };
  } catch {
    return null;
  }
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Re-export so consumers can import from a single place if needed.
export type { ChatStream };
