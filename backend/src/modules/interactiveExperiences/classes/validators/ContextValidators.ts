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
 * Generates a fresh experience from external context (v1: YouTube URL).
 * The flow is:
 *   1. Provider extracts a transcript (creator captions → auto
 *      captions → local Whisper).
 *   2. ContextBuilder summarizes it via the owner's AI config.
 *   3. The existing generation pipeline streams an HTML experience
 *      with the context injected into the system prompt.
 *
 * The teacher's `prompt` is required — the LLM still needs an
 * instruction for what to do with the context. The teacher's
 * `input` is the raw source (URL, file id, etc.).
 */
export class GenerateFromContextBody {
  @JSONSchema({
    description: 'Source identifier — only "youtube" in v1',
    example: 'youtube',
    type: 'string',
    enum: ['youtube'],
  })
  @IsIn(['youtube'])
  source: 'youtube';

  @JSONSchema({
    description:
      'Source-specific input. For youtube: a YouTube URL or bare 11-char video id.',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    type: 'string',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
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
