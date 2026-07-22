/**
 * Context Provider architecture — types and the load-bearing contract.
 *
 * A ContextProvider takes raw teacher input (a YouTube URL, a PDF blob,
 * an audio file, a course item id, …) and produces a normalized
 * `GenerationContext` that the LLM prompt can consume. The ILE
 * generation pipeline doesn't care what the source is — it just reads
 * the context and injects it into the system prompt.
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
 */

/** Source identifiers — useful for analytics + the "Context: …" chip. */
export type ContextSourceId =
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
  source: ContextSourceId;
  /**
   * Owner id (the teacher). The summarizer uses this to look up the
   * owner's AI config. Optional — when omitted, summarization uses
   * extractive fallback only.
   */
  ownerId?: string;
}

/**
 * Structured educational content. The `text` field is always present
 * and is the primary input to the LLM prompt. Other fields are
 * provider-specific.
 */
export interface ContextBody {
  /** Long-form text. Always present. Capped at a generous size. */
  text: string;
  /** Optional chapters/sections for prompt grounding. */
  chapters?: Array<{ title: string; startSec?: number; text: string }>;
  /** Optional concepts the provider already extracted. */
  concepts?: string[];
  /** Source-specific metadata (duration, author, language, page count). */
  meta: Record<string, unknown>;
}

/** Pre-summarized key concepts. Filled by `TranscriptCleaner`. */
export interface ContextSummary {
  shortSummary: string;
  keyConcepts: string[];
  learningObjectives?: string[];
  misconceptions?: string[];
  interactiveOpportunities?: string[];
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
 * Normalized context that goes into the LLM prompt. Same shape
 * regardless of source (YouTube, PDF, audio, …).
 */
export interface GenerationContext {
  source: ContextSourceId;
  /** Display title — used in the workspace "Context: …" chip. */
  title: string;
  /** Original input as the teacher provided it (URL, file id, …). */
  originalInput: string;
  body: ContextBody;
  /** Pre-summarized content. Optional — providers can pre-summarize. */
  summary?: ContextSummary;
  /** Append-only record of which strategies were attempted. */
  provenance: ContextProvenanceEntry[];
}

/**
 * Phase reporting hook. Providers and the builder call this with
 * user-facing progress messages. The SSE layer maps them onto the
 * `progress` event channel.
 */
export interface ContextPhase {
  /** Stable id for the phase (useful for tests/dedup). */
  id: string;
  /** Teacher-facing label — no implementation details exposed. */
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
   * Produce the context. Implementations handle their own fallback
   * chains internally. Must never throw raw errors — providers are
   * responsible for translating everything into a `ContextProviderError`.
   */
  buildContext(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<GenerationContext>;
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
 * Phase ids used across providers. Centralised so the SSE progress
 * log can dedup identical phases cleanly.
 */
export const CONTEXT_PHASES = {
  PICKING_SOURCE: { id: 'picking-source', label: 'Preparing video context...' },
  FETCHING_META: { id: 'fetching-meta', label: 'Preparing video context...' },
  READING_CAPTIONS: { id: 'reading-captions', label: 'Analyzing educational content...' },
  NO_CAPTIONS_FALLBACK: {
    id: 'no-captions-fallback',
    label: 'Analyzing educational content...',
  },
  TRANSCRIBING: { id: 'transcribing', label: 'Analyzing educational content...' },
  CLEANING_TRANSCRIPT: { id: 'cleaning-transcript', label: 'Analyzing educational content...' },
  SUMMARIZING: { id: 'summarizing', label: 'Analyzing educational content...' },
} as const;
