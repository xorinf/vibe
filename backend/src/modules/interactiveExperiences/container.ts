import { ContainerModule } from 'inversify';
import { ILE_TYPES } from './types.js';
import { IleRepository } from './repositories/IleRepository.js';
import { IleAiConfigRepository } from './repositories/IleAiConfigRepository.js';
import { IleAssetRepository } from './repositories/IleAssetRepository.js';
import { IleStudentProgressRepository } from './repositories/IleStudentProgressRepository.js';
import { IleGenerationService } from './services/IleGenerationService.js';
import { IleService } from './services/IleService.js';
import { IleSseService } from './services/IleSseService.js';
import { IleAiConfigService } from './services/IleAiConfigService.js';
import { IleAssetService } from './services/IleAssetService.js';
import { IleAssetStorageService } from './services/IleAssetStorageService.js';
import { IleAnalyticsService } from './services/IleAnalyticsService.js';
import { IleController } from './controllers/IleController.js';
import { Keystore, createKeyProvider } from './services/providers/keystore.js';
import { ContextBuilder } from './context/ContextBuilder.js';
import { ContextProviderRegistry } from './context/ContextProviderRegistry.js';
import { TranscriptCleaner } from './context/TranscriptCleaner.js';
import { YouTubeContextProvider } from './context/providers/YouTubeContextProvider.js';
import { MarkdownContextProvider } from './context/providers/MarkdownContextProvider.js';

export const ileContainerModule = new ContainerModule((options) => {
  // Infrastructure: singleton keystore is bound as a value (not a type)
  // so the same instance is shared across the repo + service without
  // needing a separate DI symbol.
  const keystore = new Keystore(createKeyProvider());
  options.bind(ILE_TYPES.Keystore).toConstantValue(keystore);
  // Repositories
  options.bind(ILE_TYPES.IleRepository).to(IleRepository).inSingletonScope();
  options
    .bind(ILE_TYPES.IleAiConfigRepository)
    .to(IleAiConfigRepository)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.IleAssetRepository)
    .to(IleAssetRepository)
    .inSingletonScope();
  // Services
  options
    .bind(ILE_TYPES.IleGenerationService)
    .to(IleGenerationService)
    .inSingletonScope();
  options.bind(ILE_TYPES.IleService).to(IleService).inSingletonScope();
  options.bind(ILE_TYPES.IleSseService).to(IleSseService).inSingletonScope();
  options
    .bind(ILE_TYPES.IleAiConfigService)
    .to(IleAiConfigService)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.IleAssetStorageService)
    .to(IleAssetStorageService)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.IleAssetService)
    .to(IleAssetService)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.IleStudentProgressRepository)
    .to(IleStudentProgressRepository)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.IleAnalyticsService)
    .to(IleAnalyticsService)
    .inSingletonScope();

  // ─────────────────────────────────────────────────────────────────
  // Context Provider architecture
  //
  // The registry is a process-wide singleton; providers register with
  // it during container setup. Order matters: more specific providers
  // (YouTube URL detection) MUST register before generic ones
  // (website). Add new providers by:
  //   1. Implementing the ContextProvider interface in
  //      context/providers/<Name>.ts.
  //   2. Adding a binding below (inSingletonScope is fine — the
  //      registry is the process-wide entry point).
  //   3. Calling `registry.register(provider)` after the container
  //      finishes loading (see interactiveExperiencesModuleOptions).
  // ─────────────────────────────────────────────────────────────────
  options
    .bind(ILE_TYPES.ContextProviderRegistry)
    .to(ContextProviderRegistry)
    .inSingletonScope();

  options
    .bind(ILE_TYPES.TranscriptCleaner)
    .to(TranscriptCleaner)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.YouTubeContextProvider)
    .to(YouTubeContextProvider)
    .inSingletonScope();
  options
    .bind(ILE_TYPES.MarkdownContextProvider)
    .to(MarkdownContextProvider)
    .inSingletonScope();
  options.bind(ILE_TYPES.ContextBuilder).to(ContextBuilder).inSingletonScope();

  // Controllers
  options.bind(IleController).toSelf().inSingletonScope();
});