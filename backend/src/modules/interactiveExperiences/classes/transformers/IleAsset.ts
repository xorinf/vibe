import { Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongodb';
import {
  ObjectIdToString,
  StringToObjectId,
} from '#root/shared/constants/transformerConstants.js';
import { ID } from '#root/shared/interfaces/models.js';

/**
 * Asset kinds the teacher can upload. The shape maps directly to the
 * per-kind upload limit + mimetype allowlist enforced in the validators.
 */
export type IleAssetKind = 'image' | 'audio' | 'video' | 'pdf' | 'svg' | 'markdown';

export const ILE_OWNER_DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;

export const ILE_ASSET_KINDS: IleAssetKind[] = [
  'image',
  'audio',
  'video',
  'pdf',
  'svg',
  'markdown',
];

/** UI display labels — kept terse for the asset-picker chip. */
export const ILE_ASSET_KIND_LABELS: Record<IleAssetKind, string> = {
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDF',
  svg: 'SVG',
  markdown: 'Markdown',
};

/**
 * Per-kind mimetype allowlist + size cap. Mirrored in the multer
 * options so the validator and the parser enforce the same rules.
 * Keep these conservative — the generated HTML lives inside a sandboxed
 * iframe with a strict CSP, so exotic formats wouldn't render anyway.
 */
export const ILE_ASSET_LIMITS: Record<
  IleAssetKind,
  { mimetypes: readonly string[]; maxBytes: number }
> = {
  image: {
    mimetypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxBytes: 10 * 1024 * 1024,
  },
  audio: {
    mimetypes: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
    maxBytes: 20 * 1024 * 1024,
  },
  video: {
    mimetypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    maxBytes: 50 * 1024 * 1024,
  },
  pdf: {
    mimetypes: ['application/pdf'],
    maxBytes: 25 * 1024 * 1024,
  },
  svg: {
    mimetypes: ['image/svg+xml'],
    maxBytes: 2 * 1024 * 1024,
  },
  markdown: {
    mimetypes: ['text/markdown', 'text/x-markdown'],
    maxBytes: 512 * 1024,
  },
};

/**
 * Per-asset metadata persisted in Mongo. The actual bytes live in GCS
 * under `storageKey`; we don't bake signed URLs into the document
 * because they expire.
 */
export class IleAsset {
  @Expose()
  @Transform(ObjectIdToString.transformer, { toPlainOnly: true })
  @Transform(StringToObjectId.transformer, { toClassOnly: true })
  _id?: ID;

  @Expose()
  ownerId: string;

  @Expose()
  kind: IleAssetKind;

  /** The original filename as uploaded by the teacher — for display. */
  @Expose()
  filename: string;

  @Expose()
  contentType: string;

  @Expose()
  size: number;

  /** Path inside the GCS bucket. Opaque to the client. */
  @Expose()
  storageKey: string;

  sha256?: string;
  thumbnailKey?: string;
  meta?: { width?: number; height?: number; encoding?: string };
  displayName?: string;
  tags?: string[];
  favorite?: boolean;
  deletedAt?: Date;

  @Expose()
  createdAt: Date;

  @Expose()
  updatedAt: Date;

  constructor(init: Partial<IleAsset> = {}) {
    this._id = init._id ?? new ObjectId();
    this.ownerId = init.ownerId ?? '';
    this.kind = init.kind ?? 'image';
    this.filename = init.filename ?? '';
    this.contentType = init.contentType ?? '';
    this.size = init.size ?? 0;
    this.storageKey = init.storageKey ?? '';
    this.createdAt = init.createdAt ?? new Date();
    this.updatedAt = init.updatedAt ?? new Date();
  }
}