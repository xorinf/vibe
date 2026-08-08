import {
  ChatStream,
  IleAiConfig,
  IleProviderId,
  PROVIDER_DEFAULTS,
} from './types.js';
import { AnthropicProvider } from './anthropicProvider.js';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider.js';

/**
 * Provider factory. Add a new provider here, nothing else in the ILE module
 * needs to change.
 *
 * IMPORTANT: This is intentionally NOT a platform-wide provider manager.
 * It only knows about the providers the ILE generation supports. If you
 * find yourself wanting to share this with another module, that's a sign
 * the abstraction is in the wrong place — open a new conversation.
 */
export function createProvider(config: IleAiConfig): ChatStream {
  const provider = config.provider;
  const apiKey = config.apiKey;
  const model = config.model;

  // anthropic + MiniMax route through the Anthropic SDK. MiniMax's
  // working endpoint is Anthropic-compatible; default baseUrl points
  // there. Teachers can override via config.baseUrl.
  if (provider === 'anthropic' || provider === 'MiniMax') {
    const baseUrl =
      config.baseUrl && config.baseUrl.trim().length > 0
        ? config.baseUrl
        : PROVIDER_DEFAULTS[provider].baseUrl;
    return new AnthropicProvider(apiKey, model, baseUrl);
  }

  // openai, openrouter, custom — OpenAI-compatible chat-completions.
  const baseUrl =
    config.baseUrl && config.baseUrl.trim().length > 0
      ? config.baseUrl
      : PROVIDER_DEFAULTS[provider as Exclude<IleProviderId, 'custom'>]?.baseUrl;

  if (!baseUrl) {
    throw new Error(`Provider "${provider}" requires a base URL`);
  }

  return new OpenAICompatibleProvider(apiKey, model, baseUrl);
}

/**
 * Resolve the effective base URL for a given provider. Used by the
 * config UI to pre-fill the field when the user picks a provider.
 */
export function defaultBaseUrlFor(provider: IleProviderId): string | undefined {
  if (provider === 'custom') return undefined;
  return PROVIDER_DEFAULTS[provider].baseUrl;
}

export function defaultModelFor(provider: IleProviderId): string {
  if (provider === 'custom') return '';
  return PROVIDER_DEFAULTS[provider].defaultModel;
}
