import { JSONSchema } from 'class-validator-jsonschema';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for POST /api/interactive-experiences/generate/stream
 * and POST /api/interactive-experiences/:id/edit/stream
 */
export class GenerateIleBody {
  @JSONSchema({
    description: 'Teacher prompt describing the experience to generate',
    example: 'Explain binary search with a step-through visualization',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  prompt: string;

  @JSONSchema({
    description: 'Course ID (for owner/scope checks)',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseId: string;

  @JSONSchema({
    description: 'Course version ID (for owner/scope checks)',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseVersionId: string;

  @JSONSchema({
    description: 'Optional item ID — set when generating from an item context',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  itemId?: string;
}

/**
 * Body for POST /api/interactive-experiences (save / update)
 */
export class SaveIleBody {
  @JSONSchema({
    description: 'Existing experience ID — omit on first save',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  _id?: string;

  @JSONSchema({
    description: 'Course ID',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseId: string;

  @JSONSchema({
    description: 'Course version ID',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseVersionId: string;

  @JSONSchema({
    description: 'Optional item ID to bind this experience to',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  itemId?: string;

  @JSONSchema({
    description: 'Title for the experience',
    example: 'Binary Search Visualizer',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  title: string;

  @JSONSchema({
    description: 'Original generation prompt',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  prompt: string;

  @JSONSchema({
    description: 'Generated HTML payload',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  html: string;
}

export class IleIdParam {
  @JSONSchema({ type: 'string' })
  @IsNotEmpty()
  @IsString()
  id: string;
}

// ─────────────────────────────────────────────────────────────────────
// Asset validators

/**
 * Per-kind multer options. Enforced both here (so non-controller callers
 * can't bypass) and in the controller via @UploadedFile options.
 * Limits are mirrored in ILE_ASSET_LIMITS in the transformer.
 */
import multer from 'multer';

function makeUploadOptions(opts: {
  allowed: readonly string[];
  maxBytes: number;
}): multer.Options {
  return {
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxBytes },
    fileFilter: (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      if (opts.allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        // Reject early — the controller's @UploadedFile options
        // callback would do the same, but doing it here means non-HTTP
        // callers (e.g. tests) get the same guard.
        cb(new Error(`Mimetype ${file.mimetype} not allowed for this kind`));
      }
    },
  };
}

import { ILE_ASSET_LIMITS, ILE_ASSET_KINDS, IleAssetKind } from '../transformers/IleAsset.js';

export const ILE_ASSET_UPLOAD_OPTIONS: Record<IleAssetKind, multer.Options> = ILE_ASSET_KINDS.reduce(
  (acc, kind) => {
    const limits = ILE_ASSET_LIMITS[kind];
    acc[kind] = makeUploadOptions({
      allowed: limits.mimetypes,
      maxBytes: limits.maxBytes,
    });
    return acc;
  },
  {} as Record<IleAssetKind, multer.Options>,
);

/** Query params for GET /assets — search + kind filter + limit. */
export class ListIleAssetsQuery {
  @JSONSchema({ type: 'string', enum: ILE_ASSET_KINDS as unknown as string[] })
  @IsOptional()
  @IsString()
  kind?: IleAssetKind;

  @JSONSchema({ type: 'string', description: 'Substring match on filename' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * PATCH /api/interactive-experiences/:id
 * Body for renaming. Only `title` is mutable via this endpoint.
 */
export class RenameIleBody {
  @JSONSchema({
    description: 'New title for the experience',
    example: 'Binary Search Visualizer (renamed)',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  title: string;
}

/**
 * POST /api/interactive-experiences/:id/save
 * Body for explicit Save (always versioned). Mirrors SaveIleBody but
 * lives on the resource path so the version-snapshot semantics are clear.
 */
export class VersionedSaveIleBody {
  @JSONSchema({
    description: 'Course ID',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseId: string;

  @JSONSchema({
    description: 'Course version ID',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  courseVersionId: string;

  @JSONSchema({
    description: 'Optional item ID to bind this experience to',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  itemId?: string;

  @JSONSchema({
    description: 'Title for the experience',
    example: 'Binary Search Visualizer',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  title: string;

  @JSONSchema({
    description: 'Original generation prompt',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  prompt: string;

  @JSONSchema({
    description: 'Generated HTML payload',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  html: string;

  @JSONSchema({
    description: 'Optional short label for this version (e.g. "Fixed typo in header")',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class IleVersionParam {
  @JSONSchema({ type: 'integer', minimum: 1 })
  @IsNotEmpty()
  version: number;
}

const PROVIDER_VALUES = ['anthropic', 'openai', 'MiniMax', 'openrouter', 'custom'] as const;

/**
 * PUT /api/interactive-experiences/config
 *
 * Body for upserting the per-owner ILE AI configuration. The apiKey is
 * OPTIONAL in the body — if omitted/empty we preserve the previously
 * stored key, so editing model/baseUrl doesn't require re-entering it.
 */
export class IleAiConfigBody {
  @JSONSchema({
    description: 'AI provider id',
    example: 'anthropic',
    enum: PROVIDER_VALUES as unknown as string[],
  })
  @IsIn(PROVIDER_VALUES as unknown as string[])
  provider: (typeof PROVIDER_VALUES)[number];

  @JSONSchema({
    description:
      'API key. Omit or leave empty to keep the previously stored key.',
    example: 'sk-...',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  apiKey?: string;

  @JSONSchema({
    description: 'Model identifier passed to the provider',
    example: 'claude-sonnet-4-5',
    type: 'string',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  model: string;

  @JSONSchema({
    description:
      'Base URL. Required for the "custom" provider; optional override for OpenRouter; ignored for Anthropic/OpenAI/MiniMax (defaults applied).',
    example: 'https://api.example.com/v1',
    type: 'string',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  baseUrl?: string;
}

/**
 * POST /api/interactive-experiences/config/test
 *
 * Body for the test-connection endpoint. Every field is optional — if
 * absent we test against the stored config. This lets the UI test the
 * saved config without re-submitting fields.
 */
export class TestIleAiConfigBody {
  @JSONSchema({ enum: PROVIDER_VALUES as unknown as string[] })
  @IsOptional()
  @IsIn(PROVIDER_VALUES as unknown as string[])
  provider?: (typeof PROVIDER_VALUES)[number];

  @JSONSchema({ description: 'Override API key for this test only', type: 'string' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  apiKey?: string;

  @JSONSchema({ description: 'Override model for this test only', type: 'string' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @JSONSchema({ description: 'Override base URL for this test only', type: 'string' })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  baseUrl?: string;
}