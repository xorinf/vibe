import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {IleAiConfigService} from '../services/IleAiConfigService.js';
import {
  ProviderAuthenticationError,
  ProviderAuthError,
} from '../services/providers/types.js';
import * as providerFactory from '../services/providers/index.js';

/**
 * Focused tests for the catch-path of `testConnection` in
 * IleAiConfigService. The closed-kind ProviderError taxonomy is what
 * the UI branches on. The pre-fix code only checked the deprecated
 * ProviderAuthError alias, which missed the common case where the
 * SDK throws ProviderAuthenticationError directly.
 */
describe('IleAiConfigService.testConnection error mapping', () => {
  let repo: any;
  let svc: IleAiConfigService;

  beforeEach(() => {
    vi.restoreAllMocks();
    repo = {
      findByOwner: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    svc = new IleAiConfigService(repo);
    repo.findByOwner.mockResolvedValue(null);
  });

  it('maps a ProviderAuthenticationError to invalid_key', async () => {
    // Stub createProvider to return a fake provider that throws a typed
    // ProviderAuthenticationError (mirrors what asProviderError yields
    // when the Anthropic SDK gets a 401 from MiniMax).
    vi.spyOn(providerFactory, 'createProvider').mockReturnValue({
      testConnection: () => {
        throw new ProviderAuthenticationError('invalid x-api-key', {
          upstreamStatus: 401,
        });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await svc.testConnection('teacher-1', {
      provider: 'MiniMax',
      apiKey: 'sk-c-anything',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/anthropic',
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('invalid_key');
    expect(res.message).toContain('Invalid API key');
  });

  it('maps a legacy ProviderAuthError to invalid_key (back-compat)', async () => {
    vi.spyOn(providerFactory, 'createProvider').mockReturnValue({
      testConnection: () => {
        throw new ProviderAuthError('legacy 401 message');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await svc.testConnection('teacher-1', {
      provider: 'MiniMax',
      apiKey: 'sk-c-anything',
      model: 'MiniMax-M3',
    });

    expect(res.status).toBe('invalid_key');
  });

  it('maps a ProviderNetworkError to network_error', async () => {
    const {ProviderNetworkError} = await import(
      '../services/providers/types.js'
    );
    vi.spyOn(providerFactory, 'createProvider').mockReturnValue({
      testConnection: () => {
        throw new ProviderNetworkError('connection refused');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await svc.testConnection('teacher-1', {
      provider: 'MiniMax',
      apiKey: 'sk-c-anything',
      model: 'MiniMax-M3',
    });

    expect(res.status).toBe('network_error');
  });
});
