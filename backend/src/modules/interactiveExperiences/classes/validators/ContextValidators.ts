import { JSONSchema } from 'class-validator-jsonschema';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsIn,
  MaxLength,
} from 'class-validator';

/**
 * Body for POST /api/interactive-experiences/generate/from-context/stream
 *
 * Generates a fresh experience from external context. The flow:
 *   1. The registered ContextProvider matching `source` extracts a
 *      `ContextSource` (the YouTube provider does transcripts; the
 *      Markdown provider normalises pasted text).
 *   2. ContextBuilder summarizes it via the owner's AI config.
 *   3. The existing generation pipeline streams an HTML experience
 *      with the context injected into the system prompt.
 *
 * The teacher's `prompt` is required — the LLM still needs an
 * instruction for what to do with the context. The teacher's
 * `input` is the raw source (URL, file id, raw text).
 */

/**
 * The set of `source` values accepted by the from-context endpoint.
 *
 * Mirror of the registered ContextProviders — adding a new provider
 * (PDF, audio, …) requires adding its `source` here AND registering
 * the provider in `setupInteractiveExperiencesContainer`. The class
 * validator hardcodes the array so a missing provider on the
 * backend surfaces as a 400 instead of a silent no-op.
 */
export const CONTEXT_GENERATE_SOURCES = ['youtube', 'markdown'] as const;
export type ContextGenerateSource = (typeof CONTEXT_GENERATE_SOURCES)[number];

export class GenerateFromContextBody {
  @JSONSchema({
    description:
      'Source identifier — must match a registered ContextProvider. ' +
      'youtube: video URL or 11-char id; markdown: raw markdown text.',
    example: 'youtube',
    type: 'string',
    enum: CONTEXT_GENERATE_SOURCES as unknown as string[],
  })
  @IsIn(CONTEXT_GENERATE_SOURCES as unknown as string[])
  source: ContextGenerateSource;

  @JSONSchema({
    description:
      'Source-specific input. For youtube: a YouTube URL or bare 11-char video id. ' +
      'For markdown: the raw markdown text.',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    type: 'string',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64_000)
  input: string;

  @JSONSchema({
    description:
      "Teacher's prompt describing the experience to generate. The context grounds the generation; this prompt is the actual instruction.",
    example: 'Explain the key concept with an interactive simulation.',
    type: 'string',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt: string;

  @JSONSchema({
    description: 'Course ID (for owner/scope checks)',
    type: 'string',
  })
  @IsString()
  @IsNotEmpty()
  courseId: string;

  @JSONSchema({
    description: 'Course version ID (for owner/scope checks)',
    type: 'string',
  })
  @IsString()
  @IsNotEmpty()
  courseVersionId: string;

  @JSONSchema({
    description: 'Optional item ID — set when generating from an item context',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  itemId?: string;

  @JSONSchema({
    description:
      'Optional teacher hint — e.g. "focus on chapter 3" or language tag.',
    example: 'focus on the first half',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hint?: string;
}
