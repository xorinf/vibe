import { injectable } from 'inversify';
import { ContextProvider, ContextInput } from './types.js';

/**
 * Process-wide registry for context providers.
 *
 * Providers self-register during container setup (see
 * `ileContainerModule` in `container.ts`). The order of registration
 * matters: `findProvider` returns the FIRST match, so providers that
 * are more specific (e.g. YouTube URL detection) MUST register before
 * more generic ones (e.g. website).
 *
 * Why a registry, not constructor injection of every provider:
 *   - Adding a new provider shouldn't require editing every consumer.
 *   - Order is preserved naturally.
 *   - Tests can substitute a stub registry without touching DI.
 */
@injectable()
export class ContextProviderRegistry {
  private readonly providers: ContextProvider[] = [];

  /**
   * Add a provider to the registry. Called from the container module
   * during setup, NOT from application code.
   */
  register(provider: ContextProvider): void {
    if (this.providers.includes(provider)) return;
    this.providers.push(provider);
  }

  /**
   * Find the first provider that claims the input. Returns undefined
   * if no provider can handle it (e.g. unknown source type).
   */
  findProvider(input: ContextInput): ContextProvider | undefined {
    return this.providers.find((p) => p.canHandle(input));
  }

  /**
   * Number of registered providers. Used by tests and health checks.
   */
  size(): number {
    return this.providers.length;
  }

  /**
   * All registered providers. Tests use this to assert registry state.
   * Application code should use `findProvider`.
   */
  all(): readonly ContextProvider[] {
    return this.providers;
  }
}
