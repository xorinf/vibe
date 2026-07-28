import { injectable } from 'inversify';
import { createHash } from 'crypto';
import {
  CONTEXT_PHASES,
  ContextInput,
  ContextPhase,
  ContextProvider,
  ContextProviderError,
  ContextSource,
} from '../types.js';

/**
 * Markdown ContextProvider — the second concrete implementation of the
 * generic `ContextProvider` interface (after YouTube).
 *
 * MVP shape: the teacher pastes (or the upload pipeline forwards) the
 * raw markdown text into `input.primary`. The provider normalizes
 * whitespace, caps the body at `MARKDOWN_PROMPT_CHARS`, and returns
 * ONE `ContextSource`.
 *
 * No extraction library needed — markdown is text-in, text-out. The
 * `cleaner.clean()` pass used by the YouTube provider is overkill
 * here; we only need the deterministic normalisation (trim, collapse
 * runs of blank lines, strip BOM) and the content hash for cache
 * keys + provenance.
 *
 * INVARIANTS
 * ----------
 * - Same context-provider contract as YouTube (translate every error
 *   to `ContextProviderError` with a friendly `userMessage`).
 * - Honours `AbortSignal`.
 * - Returns ONE ContextSource with `type: 'markdown'`.
 *
 * Phase reporting: providers never reveal implementation details.
 * `UNDERSTANDING_MATERIAL` is the right phase label — it says
 * "we're parsing what you pasted" without exposing that it's plain
 * text.
 */
const MARKDOWN_PROMPT_CHARS = 32_000;

@injectable()
export class MarkdownContextProvider implements ContextProvider {
  canHandle(input: ContextInput): boolean {
    if (input.source === 'markdown') return true;
    return false;
  }

  async extract(
    input: ContextInput,
    signal: AbortSignal,
    onPhase: (phase: ContextPhase) => void,
  ): Promise<ContextSource> {
    const raw = (input.primary || '').trim();
    if (!raw) {
      throw new ContextProviderError(
        'Empty markdown input',
        'Paste the markdown you want to teach from.',
        'invalid_input',
      );
    }

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    onPhase(CONTEXT_PHASES.PREPARING_CONTEXT);

    const t0 = Date.now();
    const normalised = normaliseMarkdown(raw);
    const content =
      normalised.length > MARKDOWN_PROMPT_CHARS
        ? normalised.slice(0, MARKDOWN_PROMPT_CHARS) +
          `\n\n[teacher input truncated at ${MARKDOWN_PROMPT_CHARS} characters]`
        : normalised;

    if (signal.aborted) {
      throw new ContextProviderError(
        'Cancelled',
        'Generation cancelled.',
        'cancelled',
      );
    }

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 24);

    onPhase(CONTEXT_PHASES.UNDERSTANDING_MATERIAL);

    const title = deriveTitle(normalised) ?? 'Markdown source';

    const source: ContextSource = {
      // Deterministic id from the content hash so duplicate pastes
      // deduplicate naturally. (No dedup at the registry layer today
      // but if/when we add it the id is the right key.)
      id: `md-${hash}`,
      type: 'markdown',
      title,
      content,
      metadata: {
        hash,
        charCount: content.length,
        truncated: normalised.length > MARKDOWN_PROMPT_CHARS,
        // Optional hint the teacher attached when pasting (e.g. focus
        // on chapter 3, language tag). The LLM uses this when
        // deciding what to highlight in the generated experience.
        hint: input.hint,
      },
      provenance: [
        {
          strategy: 'paste',
          outcome: 'success',
          durationMs: Date.now() - t0,
        },
      ],
      createdAt: new Date(),
    };

    return source;
  }
}

/**
 * Light-touch normalisation: trim trailing whitespace, strip a UTF-8
 * BOM if present, collapse 3+ consecutive blank lines down to one. The
 * LLM prompt doesn't need a full markdown-to-text renderer — we just
 * want deterministic whitespace so the cache hash is stable.
 */
function normaliseMarkdown(input: string): string {
  let s = input;
  // Strip BOM (common when pasting from a word processor export).
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Collapse 3+ blank lines down to one (i.e. two consecutive newlines).
  s = s.replace(/\n{3,}/g, '\n\n');
  // Trim trailing whitespace on each line.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  return s.trim();
}

/**
 * Pick a short title for the source — the first heading if there is one,
 * else the first non-blank line, else null (caller falls back to default).
 */
function deriveTitle(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip leading ATX-heading markers (#, ##, ###) and trim.
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) return heading[1].slice(0, 80);
    // First non-blank, non-heading line, capped at 80 chars.
    return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
  }
  return null;
}
