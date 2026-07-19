import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { IleAssetRepository } from '../repositories/IleAssetRepository.js';
import { IleAssetStorageService } from './IleAssetStorageService.js';
import {
  IleAsset,
  IleAssetKind,
  ILE_ASSET_KINDS,
  ILE_ASSET_KIND_LABELS,
  ILE_ASSET_LIMITS,
} from '../classes/transformers/IleAsset.js';

const MAX_RECENT_ASSETS_IN_PROMPT = 8;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Lifecycle of an ILE asset: upload, list, sign, delete.
 *
 * Sits between the controller and the storage / Mongo layers. Computes
 * derived fields (storage key, content-type mapping) and gates the
 * public surface on owner-scoped queries.
 *
 * The `buildAssetContextFragment` method is the one piece this service
 * shares with the AI — it's called from IleGenerationService. We do NOT
 * inject IleGenerationService here to avoid a circular dependency
 * (the generation service already injects this one).
 */
@injectable()
export class IleAssetService {
  constructor(
    @inject(ILE_TYPES.IleAssetRepository)
    private readonly repo: IleAssetRepository,
    @inject(ILE_TYPES.IleAssetStorageService)
    private readonly storage: IleAssetStorageService,
  ) {}

  async upload(args: {
    ownerId: string;
    kind: IleAssetKind;
    filename: string;
    contentType: string;
    size: number;
    buffer: Buffer;
  }): Promise<IleAsset> {
    // Defence in depth — the controller already validated mimetype +
    // size via multer, but a future caller could bypass the controller.
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

    // Storage key uses the asset's own _id so the path is stable even
    // if the teacher renames the file later.
    const seed = new IleAsset({
      ownerId: args.ownerId,
      kind: args.kind,
      filename: args.filename,
      contentType: args.contentType,
      size: args.size,
      storageKey: '', // filled in after we know the _id
    });
    const ext = args.filename.split('.').pop()?.toLowerCase() || extFromMime(args.contentType);
    const storageKey = await this.storage.upload({
      ownerId: args.ownerId,
      kind: args.kind,
      assetId: String(seed._id),
      ext,
      buffer: args.buffer,
      contentType: args.contentType,
    });
    seed.storageKey = storageKey;
    return this.repo.insert(seed);
  }

  async list(
    ownerId: string,
    opts: { kind?: IleAssetKind; query?: string } = {},
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

  async delete(ownerId: string, id: string): Promise<boolean> {
    const doc = await this.repo.findByOwnerAndId(ownerId, id);
    if (!doc) return false;
    // Delete GCS first, then Mongo. If the GCS delete fails, the row
    // stays so the teacher can retry — better than orphaning the blob
    // with no record pointing at it.
    try {
      await this.storage.delete(doc.storageKey);
    } catch (err) {
      // Surface the error so the controller can return a 500.
      throw err;
    }
    return this.repo.deleteByOwnerAndId(ownerId, id);
  }

  /**
   * Build the prompt fragment that the AI sees when generating. Lists
   * the teacher's recent assets with their signed URLs so the model
   * can reference them by absolute URL in the generated HTML.
   *
   * The fragment is intentionally compact — long asset lists bloat
   * the prompt. We cap at the most recent 8 entries per generation.
   */
  async buildAssetContextFragment(
    ownerId: string,
  ): Promise<string | null> {
    const recent = await this.repo.listByOwner(ownerId, {
      limit: MAX_RECENT_ASSETS_IN_PROMPT,
    });
    if (recent.length === 0) return null;
    const lines = await Promise.all(
      recent.map(async (asset) => {
        const url = await this.storage.getSignedUrl(
          asset.storageKey,
          SIGNED_URL_TTL_SECONDS,
        );
        return `- [${ILE_ASSET_KIND_LABELS[asset.kind]}] ${asset.filename} (id=${asset._id}) ${url}`;
      }),
    );
    return [
      'Available teacher-uploaded assets (use these URLs directly in the generated HTML):',
      ...lines,
      'If a request references "the uploaded image" or "this PDF", pick the asset by id/filename from the list above.',
    ].join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4': return 'm4a';
    case 'video/mp4': return 'mp4';
    case 'video/webm': return 'webm';
    case 'video/quicktime': return 'mov';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

// Re-export so callers don't have to know the transformer lives
// elsewhere.
export { ILE_ASSET_KINDS, ILE_ASSET_KIND_LABELS, ILE_ASSET_LIMITS };
export type { IleAssetKind, IleAsset };