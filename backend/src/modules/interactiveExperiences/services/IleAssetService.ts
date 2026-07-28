import { injectable, inject } from 'inversify';
import { createHash } from 'crypto';
import { ILE_TYPES } from '../types.js';
import { IleAssetRepository } from '../repositories/IleAssetRepository.js';
import { IleAssetStorageService } from './IleAssetStorageService.js';
import {
  IleAsset,
  IleAssetKind,
  ILE_ASSET_LIMITS,
  ILE_OWNER_DEFAULT_QUOTA_BYTES,
} from '../classes/transformers/IleAsset.js';
import { ileLog } from './observability.js';

const MAX_RECENT_ASSETS_IN_PROMPT = 8;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Max bytes of markdown body we'll inline into the system prompt
 * (truncated on read). Keeps the context bounded for a teacher with
 * a 512KB doc.
 */
const MARKDOWN_PROMPT_CHARS = 8_000;

/**
 * Resolve the per-owner byte quota. Production overrides via env
 * (ILE_OWNER_QUOTA_BYTES). The check is the same expression for
 * `quotaForOwner` and the upload-time enforcement, so the UI shows
 * the same number it gates against.
 */
function ownerQuotaBytes(): number {
  const raw = process.env.ILE_OWNER_QUOTA_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : ILE_OWNER_DEFAULT_QUOTA_BYTES;
}

/**
 * Lifecycle of an ILE asset: upload, list, sign, delete, trash, restore,
 * patch metadata, quota.
 *
 * Major additions over the v1 surface:
 *
 *   - SHA-256 hashing + duplicate detection (re-upload is a no-op).
 *   - Per-owner storage quota enforcement at upload time.
 *   - Soft-delete + 30-day trash retention + restore.
 *   - Display name, tags, favourite.
 *   - Server-side metadata extraction for image dimensions.
 *
 * What we deliberately DON'T do server-side:
 *
 *   - Thumbnail generation. The brief asks for it; we defer the
 *     server-side path (no `sharp` dep, no system libvips, no ffmpeg)
 *     and let the browser paint the kind icon instead. The
 *     `IleAsset.thumbnailKey` field is reserved for a future
 *     server-side render — see README "Asset pipeline / Thumbnails".
 */
@injectable()
export class IleAssetService {
  constructor(
    @inject(ILE_TYPES.IleAssetRepository)
    private readonly repo: IleAssetRepository,
    @inject(ILE_TYPES.IleAssetStorageService)
    private readonly storage: IleAssetStorageService,
  ) {}

  /**
   * Upload entry point. Order of checks:
   *
   *   1. mimetype + size cap (caller already validated; double-check).
   *   2. SHA-256 the buffer; if the owner already has an active row
   *      with the same hash, return it (dedup).
   *   3. Quota: if `totalBytesForOwner + buffer.length` exceeds the
   *      per-owner cap, reject with a typed error.
   *   4. Upload to GCS + persist the row.
   *   5. Fire-and-forget metadata extraction; the doc's `meta` field
   *      is backfilled in-place.
   *
   * The duplicate path is the common case (teachers re-uploading the
   * same diagram) and must be O(1) on the hot path — one indexed
   * lookup, no upload bytes.
   */
  async upload(args: {
    ownerId: string;
    kind: IleAssetKind;
    filename: string;
    contentType: string;
    size: number;
    buffer: Buffer;
  }): Promise<IleAsset> {
    // 1. Defensive: re-validate mimetype + size. The controller's
    //    @UploadedFile options do this, but a future caller (e.g. a
    //    CLI) might bypass the HTTP boundary.
    const limits = ILE_ASSET_LIMITS[args.kind];
    if (!limits) {
      throw new Error(`Unknown asset kind: ${args.kind}`);
    }
    if (!limits.mimetypes.includes(args.contentType)) {
      throw new Error(
        `Mimetype ${args.contentType} not allowed for kind ${args.kind}`,
      );
    }
    if (args.size > limits.maxBytes) {
      throw new Error(
        `Asset exceeds size limit for ${args.kind} (${args.size} > ${limits.maxBytes})`,
      );
    }

    // 2. Hash + dedup. The hash is used as the dedup key AND as a
    //    content-addressable cache key for any future server-side
    //    thumbnail.
    const sha256 = createHash('sha256').update(args.buffer).digest('hex');
    const existing = await this.repo.findByHashForOwner(args.ownerId, sha256);
    if (existing) {
      ileLog('info', 'asset.upload.dedup', {
        ownerId: args.ownerId,
        sha256,
        assetId: String(existing._id),
      });
      return existing;
    }

    // 3. Quota.
    const quota = ownerQuotaBytes();
    const used = await this.repo.totalBytesForOwner(args.ownerId);
    if (used + args.size > quota) {
      const remaining = Math.max(0, quota - used);
      throw new AssetQuotaError(
        `Storage quota exceeded. ` +
          `${humanBytes(args.size)} upload would push you to ` +
          `${humanBytes(used + args.size)}; quota is ${humanBytes(quota)} ` +
          `(only ${humanBytes(remaining)} left). Delete an asset or ` +
          `contact support to raise the cap.`,
        { used, limit: quota, attempted: args.size },
      );
    }

    // 4. Persist.
    const seed = new IleAsset({
      ownerId: args.ownerId,
      kind: args.kind,
      filename: args.filename,
      contentType: args.contentType,
      size: args.size,
      storageKey: '', // backfilled below
      sha256,
    });
    const ext = pickExtension(args.filename, args.contentType);
    const storageKey = await this.storage.upload({
      ownerId: args.ownerId,
      kind: args.kind,
      assetId: String(seed._id),
      ext,
      buffer: args.buffer,
      contentType: args.contentType,
    });
    seed.storageKey = storageKey;
    const saved = await this.repo.insert(seed);

    // 5. Fire-and-forget metadata extraction. We don't await so the
    //    upload returns fast; the UI just sees `meta` populate on the
    //    next list/refresh. Any failure is logged, never rethrown.
    void this.extractAndPersistMetadata(saved).catch((err) => {
      ileLog('warn', 'asset.metadata.failed', {
        assetId: String(saved._id),
        ownerId: saved.ownerId,
        kind: saved.kind,
        error: (err as Error).message,
      });
    });

    ileLog('info', 'asset.upload.ok', {
      ownerId: args.ownerId,
      assetId: String(saved._id),
      kind: args.kind,
      bytes: args.size,
      sha256,
    });
    return saved;
  }

  /**
   * Pull image dimensions out of a buffer using pure Node. Supports
   * the formats we allow (PNG, JPEG, GIF, WebP, SVG). Anything else
   * returns undefined so the UI falls back to a generic preview.
   */
  private async extractAndPersistMetadata(asset: IleAsset): Promise<void> {
    if (asset.kind !== 'image') return;
    const buf = await this.storage.download(asset.storageKey).catch(() => null);
    if (!buf) return;
    const meta = readImageMeta(buf, asset.contentType);
    if (!meta) return;
    await this.repo.updateMeta(asset.ownerId, String(asset._id), {
      width: meta.width,
      height: meta.height,
      encoding: meta.encoding,
    });
  }

  async list(
    ownerId: string,
    opts: Parameters<IleAssetRepository['listByOwner']>[1] = {},
  ): Promise<IleAsset[]> {
    return this.repo.listByOwner(ownerId, opts);
  }

  async getSignedUrl(
    ownerId: string,
    id: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const doc = await this.repo.findByOwnerAndId(ownerId, id);
    if (!doc) throw new Error('Asset not found');
    const url = await this.storage.getSignedUrl(
      doc.storageKey,
      SIGNED_URL_TTL_SECONDS,
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * Same as `getSignedUrl` but for the thumbnail variant. Returns
   * `null` if the asset has no thumbnail (most assets today; UI
   * falls back to the kind icon).
   */
  async getThumbnailSignedUrl(
    ownerId: string,
    id: string,
  ): Promise<{ url: string; expiresIn: number } | null> {
    const doc = await this.repo.findByOwnerAndId(ownerId, id);
    if (!doc?.thumbnailKey) return null;
    const url = await this.storage.getSignedUrl(
      doc.thumbnailKey,
      SIGNED_URL_TTL_SECONDS,
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * Soft-delete an asset. The GCS blob is NOT removed; a later sweep
   * cleans up after the retention window.
   */
  async softDelete(ownerId: string, id: string): Promise<boolean> {
    const stamped = await this.repo.softDelete(ownerId, id);
    if (!stamped) return false;
    ileLog('info', 'asset.trash', { ownerId, assetId: id });
    return true;
  }

  /**
   * Restore a soft-deleted asset.
   */
  async restore(ownerId: string, id: string): Promise<boolean> {
    const restored = await this.repo.restore(ownerId, id);
    if (!restored) return false;
    ileLog('info', 'asset.restore', { ownerId, assetId: id });
    return true;
  }

  /**
   * Hard-delete: removes the row AND the GCS blob (and any thumbnail
   * blob). Used by the explicit "Delete permanently" affordance in
   * the trash view AND by the retention sweep.
   */
  /**
   * Alias kept for the pre-existing controller path. The new
   * `softDelete` / `hardDelete` pair is what the rest of the module
   * uses; the controller still calls `delete()` for the default
   * "user clicked trash" affordance, which is a soft-delete. The
   * retention sweep is the only caller of `hardDelete`.
   */
  async delete(ownerId: string, id: string): Promise<boolean> {
    return this.softDelete(ownerId, id);
  }

  async hardDelete(ownerId: string, id: string): Promise<boolean> {
    const removed = await this.repo.hardDelete(ownerId, id);
    if (!removed) return false;
    try {
      await this.storage.delete(removed.storageKey);
    } catch (err) {
      ileLog('warn', 'asset.gcs.delete_failed', {
        storageKey: removed.storageKey,
        error: (err as Error).message,
      });
    }
    if (removed.thumbnailKey) {
      try {
        await this.storage.delete(removed.thumbnailKey);
      } catch (err) {
        ileLog('warn', 'asset.gcs.delete_thumbnail_failed', {
          storageKey: removed.thumbnailKey,
          error: (err as Error).message,
        });
      }
    }
    ileLog('info', 'asset.hard_delete', { ownerId, assetId: id });
    return true;
  }

  async patch(
    ownerId: string,
    id: string,
    patch: { displayName?: string; tags?: string[]; favorite?: boolean },
  ): Promise<IleAsset | null> {
    return this.repo.patch(ownerId, id, patch);
  }

  /**
   * Quota summary for the owner. The UI renders a progress bar.
   */
  async getQuota(ownerId: string): Promise<{
    used: number;
    limit: number;
    available: number;
  }> {
    const limit = ownerQuotaBytes();
    const used = await this.repo.totalBytesForOwner(ownerId);
    return { used, limit, available: Math.max(0, limit - used) };
  }

  /**
   * Read the markdown body for an asset. Returns undefined for
   * non-markdown kinds. Truncated to MARKDOWN_PROMPT_CHARS so a
   * huge reference doc doesn't blow the prompt.
   */
  async readMarkdownForPrompt(
    ownerId: string,
    id: string,
  ): Promise<string | undefined> {
    const doc = await this.repo.findByOwnerAndId(ownerId, id);
    if (!doc || doc.kind !== 'markdown') return undefined;
    const buf = await this.storage.download(doc.storageKey).catch(() => null);
    if (!buf) return undefined;
    const text = buf.toString('utf8');
    if (text.length <= MARKDOWN_PROMPT_CHARS) return text;
    return text.slice(0, MARKDOWN_PROMPT_CHARS) + '\n\n[truncated]';
  }

  /**
   * Build the prompt fragment that the AI sees when generating. Lists
   * the teacher's recent assets with their signed URLs so the model
   * can reference them by absolute URL in the generated HTML.
   *
   * For markdown assets we also inline the body (truncated) so the
   * teacher can say "Create an activity around this diagram" and the
   * model sees the actual content without manual URL pasting.
   *
   * The fragment is intentionally compact — long asset lists bloat
   * the prompt. We cap at the most recent N entries per generation.
   */
  async buildAssetContextFragment(
    ownerId: string,
    options: { preferredAssetId?: string } = {},
  ): Promise<string | null> {
    const recent = await this.repo.listByOwner(ownerId, {
      limit: MAX_RECENT_ASSETS_IN_PROMPT,
    });
    if (recent.length === 0) return null;

    const lines = await Promise.all(
      recent.map(async (asset) => {
        const url = await this.storage
          .getSignedUrl(asset.storageKey, SIGNED_URL_TTL_SECONDS)
          .catch(() => null);
        if (!url) return null;
        const header = `[${asset.kind}] ${asset.filename}`;
        const ref = `(id=${asset._id}) ${url}`;
        // For markdown, inline the body so the teacher can refer
        // to it by id without copy/paste.
        if (asset.kind === 'markdown') {
          const body = await this.readMarkdownForPrompt(ownerId, String(asset._id));
          const bodyLine = body
            ? `\n--- body (${asset.filename}) ---\n${body}\n--- end body ---`
            : '';
          return `${header} ${ref}${bodyLine}`;
        }
        return `${header} ${ref}`;
      }),
    );
    const filtered = lines.filter((l): l is string => Boolean(l));
    if (filtered.length === 0) return null;

    const header = options.preferredAssetId
      ? `Available teacher-uploaded assets. The teacher specifically referenced the asset with id=${options.preferredAssetId}; use its URL/content directly.`
      : 'Available teacher-uploaded assets (use these URLs directly in the generated HTML):';
    return [
      header,
      ...filtered,
      'If a request references "the uploaded image" or "this PDF", pick the asset by id/filename from the list above.',
    ].join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Typed error raised when an upload would push the owner past their
 * storage quota. The controller catches this and returns 413 with
 * a payload that the UI can render directly.
 */
export class AssetQuotaError extends Error {
  readonly code = 'ASSET_QUOTA_EXCEEDED' as const;
  readonly used: number;
  readonly limit: number;
  readonly attempted: number;
  constructor(
    message: string,
    info: { used: number; limit: number; attempted: number },
  ) {
    super(message);
    this.name = 'AssetQuotaError';
    this.used = info.used;
    this.limit = info.limit;
    this.attempted = info.attempted;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    case 'application/pdf':
      return 'pdf';
    case 'text/markdown':
    case 'text/x-markdown':
      return 'md';
    default:
      return 'bin';
  }
}

function pickExtension(filename: string, contentType: string): string {
  const fromName = filename.split('.').pop()?.toLowerCase() ?? '';
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName) && fromName !== 'bin') {
    return fromName;
  }
  return extFromMime(contentType);
}

/** Human-readable byte count. Locale-independent, just for logs/UI. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ─────────────────────────────────────────────────────────────────────
// Pure-Node image dimension extraction
// ─────────────────────────────────────────────────────────────────────

/**
 * Read width/height out of the first bytes of a PNG, JPEG, GIF, WebP,
 * or SVG buffer. Returns undefined if the format isn't recognised.
 *
 * Why not `sharp`: it pulls libvips and 20MB+ of native binaries, and
 * this codebase deliberately stays portable. The dimensions are all
 * the UI needs for proper aspect-ratio placeholders.
 */
function readImageMeta(
  buf: Buffer,
  contentType: string,
):
  | { width: number; height: number; encoding?: string }
  | undefined {
  // PNG: 8-byte signature, then IHDR chunk (length 13, type 'IHDR', 4 bytes width, 4 bytes height)
  if (
    contentType === 'image/png' &&
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, encoding: 'png' };
  }
  // JPEG: scan for SOF0/SOF2 marker (0xFFC0 / 0xFFC2) which carries
  // 8-bit precision + 2 bytes height + 2 bytes width immediately after.
  if (contentType === 'image/jpeg') {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      // Stand-alone markers (no length word): RST0..RST7 (0xD0..0xD7),
      // SOI (0xD8), EOI (0xD9), TEM (0x01), plus the byte-stuffing 0xFF.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01 ||
        marker === 0xff
      ) {
        i += 2;
        continue;
      }
      // Skip the segment (length word includes itself).
      const segLen = buf.readUInt16BE(i + 2);
      if (
        (marker === 0xc0 || marker === 0xc2) &&
        i + 2 + segLen + 5 <= buf.length
      ) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height, encoding: 'jpeg' };
      }
      i += 2 + segLen;
    }
    return undefined;
  }
  // GIF: 'GIF87a' / 'GIF89a' magic, then logical-screen width (LE 2B) + height (LE 2B) at offset 6.
  if (
    (contentType === 'image/gif') &&
    buf.length >= 10 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height, encoding: 'gif' };
  }
  // WebP: 'RIFF' + 4 bytes size + 'WEBP' then a chunk ('VP8 ' / 'VP8L' / 'VP8X').
  if (contentType === 'image/webp' && buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      // Lossy: 7-byte VP8 bitstream header; width/height at 8-9, 10-11 (LE 14-bit)
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, encoding: 'webp-lossy' };
    }
    if (chunk === 'VP8L') {
      // Lossless: 14-bit width-1 and 14-bit height-1 packed into 4 bytes.
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      const width = ((b1 & 0x3f) << 8 | b0) + 1;
      const height = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1;
      return { width, height, encoding: 'webp-lossless' };
    }
    if (chunk === 'VP8X') {
      // Extended: width-1 (24-bit LE) at offset 24, height-1 (24-bit LE) at offset 27.
      const w0 = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h0 = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w0 + 1, height: h0 + 1, encoding: 'webp-extended' };
    }
  }
  // SVG: viewBox or width/height attributes in the first 2KB.
  if (contentType === 'image/svg+xml') {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 2048));
    const w = matchAttr(head, /\bwidth\s*=\s*"([\d.]+)/i);
    const h = matchAttr(head, /\bheight\s*=\s*"([\d.]+)/i);
    const vb = matchAttr(head, /\bviewBox\s*=\s*"\s*([\d.\s-]+)\s*"/i);
    let width = w ? Math.round(Number(w)) : undefined;
    let height = h ? Math.round(Number(h)) : undefined;
    if ((!width || !height) && vb) {
      const parts = vb.trim().split(/\s+/);
      if (parts.length === 4) {
        width = width ?? Math.round(Number(parts[2]));
        height = height ?? Math.round(Number(parts[3]));
      }
    }
    if (width && height) return { width, height, encoding: 'svg' };
  }
  return undefined;
}

function matchAttr(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m?.[1];
}