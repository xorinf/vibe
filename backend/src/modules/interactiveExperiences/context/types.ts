/**
 * Context Provider architecture — types and the load-bearing contract.
 *
 * A ContextProvider takes raw teacher input (a YouTube URL, a PDF blob,
 * an audio file, a course item id, …) and produces ONE `ContextSource`.
 * The ContextBuilder composes one or more ContextSources into a
 * `GenerationContext` for the LLM prompt.
 *
 * The ILE generation pipeline doesn't care what the sources are — it
 * just reads the merged content and summary and injects them into the
 * system prompt.
 *
 * Future providers (PDF, Course Item, Audio, OCR, Website, …) plug
 * in by implementing the `ContextProvider` interface and registering
 * with `ContextProviderRegistry`. No generation code changes are
 * required.
 *
 * INVARIANTS
 * ----------
 * 1. Providers MUST translate every raw error (network failure, library
 *    exception, missing dependency) into a `ContextProviderError` with
 *    a `userMessage` — the UI only ever displays `userMessage`, never
 *    raw error text. Internal details stay in `ileLog` only.
 *
 * 2. Providers MUST record every strategy attempt in `provenance[]`.
 *    The analytics layer answers "what fraction of YouTube contexts
 *    fall through to Whisper?" from this array — without us adding
 *    any logging today.
 *
 * 3. Providers MUST honour `AbortSignal` and throw a
 *    `ContextProviderError(kind: 'cancelled')` when it fires. No raw
 *    stack traces, no silent hangs.
 *
 * 4. `canHandle` MUST be cheap (no HTTP calls). It runs on every input
 *    the system sees.
 *
 * 5. A provider returns exactly ONE ContextSource. Composing multiple
 *    sources (current lesson + YouTube, multiple videos, …) is the
 *    ContextBuilder's job, not the provider's.
 */

/** Source type identifiers — used for routing + UI grouping. */
export type ContextSourceType =
  | 'youtube'
  | 'pdf'
  | 'markdown'
  | 'audio'
  | 'image'
  | 'course_item'
  | 'website'
  | 'video_file'
  | 'slides'
  | 'manual';

/** Canonical input shape — providers decide what to do with it. */
export interface ContextInput {
  /** Teacher-supplied primary input (URL, file id, raw text). */
  primary: string;
  /** Optional teacher hint — e.g. "focus on chapter 3" or language tag. */
  hint?: string;
  /**
   * Source identifier. Lets the menu pre-route ("YouTube" → YouTube
   * provider) without relying solely on URL sniffing.
   */
  source: ContextSourceType;
  /**
   * Owner id (the teacher). The summarizer uses this to look up the
   * owner's AI config. Optional — when omitted, summarization uses
   * extractive fallback only.
   */
  ownerId?: string;
}

/**
 * A single extracted source. Provider-agnostic — every provider returns
 * one of these. The `metadata` bag holds provider-specific fields
 * (videoId, duration, pageCount, language, transcriptHash, …).
 *
 * `content` is the long-form text the LLM prompt consumes. The builder
 * may cap it.
 */
export interface ContextSource {
  /** Stable id (e.g. youtube videoId, file id). For deduplication. */
  id: string;
  /** Source type identifier. */
  type: ContextSourceType;
  /** Display title — used in the "Context: …" chip. */
  title: string;
  /** Long-form text. Always present. Capped at a generous size. */
  content: string;
  /**
   * Provider-specific metadata (duration, author, language, page count,
   * transcriptHash for cache-key future, …).
   */
  metadata: Record<string, unknown>;
  /**
   * Append-only record of which strategies / fallbacks the provider
   * used. Useful for analytics + debugging.
   */
  provenance: ContextProvenanceEntry[];
  /** When the source was extracted. */
  createdAt: Date;
}

/**
 * A single attempt by a provider's internal strategy. Provenance is
 * appended in order — the first `outcome: 'success'` entry tells the
 * caller which strategy won.
 */
export interface ContextProvenanceEntry {
  strategy: string;
  outcome: 'success' | 'unavailable' | 'failed';
  durationMs: number;
  note?: string;
}

/**
 * Pre-summarized key concepts. Filled by the builder's summarizer.
 */
export interface ContextSummary {
  shortSummary: string;
  keyConcepts: string[];
  learningObjectives?: string[];
  misconceptions?: string[];
  interactiveOpportunities?: string[];
}

/**
 * The composed context the LLM prompt consumes. Built by
 * ContextBuilder from one or more ContextSources.
 *
 * `mergedContent` is the joined text the prompt actually quotes.
 * `sources[]` preserves the per-source structure for chips, audit
 * trails, and selective re-generation.
 */
export interface GenerationContext {
  /** All sources that contributed to this context. */
  sources: ContextSource[];
  /** Joined long-form text. Always present. Builder-capped. */
  mergedContent: string;
  /** Optional pre-summary. Builder-produced when sources warrant. */
  summary?: ContextSummary;
}

/**
 * Phase reporting hook. Providers and the builder call this with
 * user-facing progress messages. The SSE layer maps them onto the
 * existing `progress` event channel.
 */
export interface ContextPhase {
  /** Stable id for the phase (useful for tests/dedup). */
  id: string;
  /**
   * Teacher-facing label — NO implementation details. Allowed values
   * come from CONTEXT_PHASES below; custom strings must NOT mention
   * yt-dlp, Whisper, Python, captions, audio, stack traces, etc.
   */
  label: string;
}

/**
 * The ContextProvider contract. Implementations are responsible for
 * their own fallback chain (so the YouTube provider tries creator
 * captions → auto captions → Whisper internally, without bubbling
 * fallback logic to the builder).
 */
export interface ContextProvider {
  /**
   * Cheap check used to route an input to the right provider. MUST NOT
   * make network calls or perform expensive computation.
   */
  canHandle(input: ContextInput): boolean;

  /**
   * Extract ONE ContextSource. Implementations handle their own
   * fallback chains internally. Must never throw raw errors — providers
   * are responsible for translating everything into a `ContextProviderError`.
   */
  extract(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<ContextSource>;
}

/**
 * Error envelope for every provider failure. The `userMessage` is the
 * ONLY string the UI is allowed to surface. The `kind` lets the UI
 * pick an icon + retry affordance.
 */
export class ContextProviderError extends Error {
  readonly userMessage: string;
  readonly kind:
    | 'unavailable' // nothing could extract context — final failure
    | 'invalid_input' // bad URL, missing fields — final failure
    | 'cancelled' // teacher cancelled — final failure
    | 'transient' // network blip — UI should offer retry
    | 'unsupported' // region-blocked / private / age-restricted — final
    | 'not_configured' // optional deps missing (e.g. Whisper) — final
    | 'unknown'; // defence in depth — should reduce over time

  constructor(
    message: string,
    userMessage: string,
    kind: ContextProviderError['kind'],
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ContextProviderError';
    this.userMessage = userMessage;
    this.kind = kind;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Teacher-facing phase labels. Centralised so the SSE progress log
 * can dedup identical phases cleanly and so all providers use the
 * same user-facing vocabulary.
 *
 * RULE: NO implementation details. No mentions of yt-dlp, Whisper,
 * Python, captions, audio, stack traces, subprocess, etc.
 */
export const CONTEXT_PHASES = {
  PREPARING_CONTEXT: { id: 'preparing-context', label: 'Preparing context...' },
  UNDERSTANDING_MATERIAL: {
    id: 'understanding-material',
    label: 'Understanding the learning material...',
  },
  SUMMARIZING: { id: 'summarizing', label: 'Understanding the learning material...' },
} as const;
