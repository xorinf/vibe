import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * One focused check for the Anthropic SDK routing path:
 *   - anthropic → AnthropicProvider
 *   - MiniMax  → AnthropicProvider with the MiniMax Anthropic-compat URL
 *   - openai/openrouter/custom → OpenAICompatibleProvider
 *
 * Ponytail: stub the SDK constructor calls so the test runs offline.
 */

describe('createProvider routing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes anthropic to AnthropicProvider with the Anthropic default URL', async () => {
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(function (this: any, opts: any) {
        this.opts = opts;
      }),
    }));
    const {createProvider} = await import('../services/providers/index.js');
    const provider = createProvider({
      ownerId: 't1',
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
    } as any);
    expect((provider as any).baseUrl).toBe('https://api.anthropic.com');
  });

  it('routes MiniMax to AnthropicProvider with the MiniMax Anthropic-compat URL as default', async () => {
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(function (this: any, opts: any) {
        this.opts = opts;
      }),
    }));
    const {createProvider} = await import('../services/providers/index.js');
    const provider = createProvider({
      ownerId: 't1',
      provider: 'MiniMax',
      apiKey: 'sk-test',
      model: 'MiniMax/MiniMax-M3',
    } as any);
    expect((provider as any).baseUrl).toBe('https://api.minimax.com/anthropic');
  });

  it('routes openai to OpenAICompatibleProvider', async () => {
    const {createProvider} = await import('../services/providers/index.js');
    const provider = createProvider({
      ownerId: 't1',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    } as any);
    expect((provider as any).baseUrl).toBe('https://api.openai.com/v1');
  });
});
