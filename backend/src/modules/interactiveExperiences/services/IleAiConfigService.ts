import { injectable, inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { IleAiConfigRepository } from '../repositories/IleAiConfigRepository.js';
import {
  IleAiConfig,
  IleAiConfigResponse,
  IleProviderId,
  TestConnectionResult,
} from './providers/types.js';
import {
  createProvider,
  defaultBaseUrlFor,
  defaultModelFor,
} from './providers/index.js';
import {
  ProviderAuthError,
  ProviderNetworkError,
} from './providers/types.js';

const KEY_MASK_PREVIEW_CHARS = 4;

/**
 * Masks an API key for display: keep the first/last few chars and replace
 * the middle with dots. Never returns the full key.
 *
 * Defensive: older rows in Mongo may have the key stored as a Buffer
 * (or some other non-string type) from a previous write path. We
 * coerce to string first so a single bad row doesn't 500 the
 * /api/interactive-experiences/config endpoint for the whole
 * teacher. The next save through the normal path will overwrite
 * it with a real string.
 */
function maskKey(key: unknown): string {
  if (key == null) return '';
  const s =
    typeof key === 'string'
      ? key
      : Buffer.isBuffer(key)
        ? key.toString('utf8')
        : typeof key === 'object' && 'toString' in (key as object)
          ? (key as { toString(): string }).toString()
          : '';
  if (!s) return '';
  if (s.length <= KEY_MASK_PREVIEW_CHARS * 2 + 3) {
    return '••••';
  }
  const start = s.slice(0, KEY_MASK_PREVIEW_CHARS);
  const end = s.slice(-KEY_MASK_PREVIEW_CHARS);
  return `${start}••••${end}`;
}

function toResponse(cfg: IleAiConfig | null): IleAiConfigResponse | null {
  if (!cfg) return null;
  return {
    ownerId: cfg.ownerId,
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    apiKeyMasked: cfg.apiKey ? maskKey(cfg.apiKey) : undefined,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  };
}

@injectable()
export class IleAiConfigService {
  constructor(
    @inject(ILE_TYPES.IleAiConfigRepository)
    private readonly repo: IleAiConfigRepository,
  ) {}

  /** Returns the sanitized config (no full API key) or null. */
  async getForOwner(ownerId: string): Promise<IleAiConfigResponse | null> {
    const cfg = await this.repo.findByOwner(ownerId);
    return toResponse(cfg);
  }

  /**
   * Upsert a config. If `apiKey` is empty AND an existing config exists,
   * we keep the previous key (so the UI's password field doesn't have to
   * re-submit a key on every other-field edit).
   */
  async upsertForOwner(
    ownerId: string,
    input: {
      provider: IleProviderId;
      apiKey?: string;
      model: string;
      baseUrl?: string;
    },
  ): Promise<IleAiConfigResponse> {
    const existing = await this.repo.findByOwner(ownerId);
    const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : existing?.apiKey ?? '';

    // Resolve base URL: explicit input wins, else existing, else default.
    let baseUrl = input.baseUrl && input.baseUrl.length > 0 ? input.baseUrl : existing?.baseUrl;
    if (!baseUrl) {
      baseUrl = defaultBaseUrlFor(input.provider);
    }

    const cfg: IleAiConfig = {
      ownerId,
      provider: input.provider,
      apiKey,
      model: input.model,
      baseUrl,
    };
    const saved = await this.repo.upsert(ownerId, cfg);
    const response = toResponse(saved);
    if (!response) throw new Error('Failed to build response after upsert');
    return response;
  }

  /**
   * Test the connection using either the provided config (preferred — what
   * the user just typed) or the stored one (if they didn't re-enter fields).
   */
  async testConnection(
    ownerId: string,
    input?: {
      provider?: IleProviderId;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
    },
  ): Promise<TestConnectionResult> {
    const existing = await this.repo.findByOwner(ownerId);

    // Merge: input wins over existing for fields it provided.
    const provider = input?.provider ?? existing?.provider;
    const apiKey =
      input?.apiKey && input.apiKey.length > 0 ? input.apiKey : existing?.apiKey;
    const model = input?.model ?? existing?.model;
    const baseUrl =
      input?.baseUrl && input.baseUrl.length > 0
        ? input.baseUrl
        : existing?.baseUrl ?? defaultBaseUrlFor(provider as IleProviderId);

    if (!provider) {
      return { ok: false, status: 'not_configured', message: 'No provider selected yet.' };
    }
    if (!apiKey) {
      return { ok: false, status: 'not_configured', message: 'API key is required.' };
    }
    if (!model) {
      return { ok: false, status: 'not_configured', message: 'Model is required.' };
    }

    const cfg: IleAiConfig = { ownerId, provider, apiKey, model, baseUrl };
    let providerInstance;
    try {
      providerInstance = createProvider(cfg);
    } catch (err: any) {
      return { ok: false, status: 'not_configured', message: err?.message };
    }

    try {
      if ('testConnection' in providerInstance && typeof (providerInstance as any).testConnection === 'function') {
        await (providerInstance as any).testConnection();
      } else {
        // Fallback: open the stream and consume the first chunk.
        const it = providerInstance.stream({
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 1,
          temperature: 0,
        });
        // We want the first meaningful chunk — skip any meta sentinels
        // (_stream_meta is emitted at the END of a stream and contains no
        // user-visible text, so for a probe it's irrelevant).
        for await (const chunk of it) {
          if (chunk.kind !== '_stream_meta') break;
        }
      }
      return { ok: true, status: 'connected', modelEcho: model };
    } catch (err: any) {
      if (err instanceof ProviderAuthError) {
        return { ok: false, status: 'invalid_key', message: err.message };
      }
      if (err instanceof ProviderNetworkError) {
        return { ok: false, status: 'network_error', message: err.message };
      }
      // Map unknown errors defensively — status code sniffing is the fallback.
      const status = err?.status ?? err?.response?.status;
      if (status === 401 || status === 403) {
        return { ok: false, status: 'invalid_key', message: err?.message };
      }
      return { ok: false, status: 'network_error', message: err?.message ?? 'Unknown error' };
    }
  }

  /** Used by IleGenerationService — keeps the key plumbing out of that file. */
  async loadConfigForOwner(ownerId: string): Promise<IleAiConfig | null> {
    return this.repo.findByOwner(ownerId);
  }
}
