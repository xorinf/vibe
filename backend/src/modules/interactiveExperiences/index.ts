import { Container, ContainerModule } from 'inversify';
import {
  RoutingControllersOptions,
  useContainer,
} from 'routing-controllers';
import { sharedContainerModule } from '#root/container.js';
import { InversifyAdapter } from '#root/inversify-adapter.js';
import { ileContainerModule } from './container.js';
import { ILE_TYPES } from './types.js';
import { IleController } from './controllers/IleController.js';
import {
  GenerateIleBody,
  IleAiConfigBody,
  IleIdParam,
  ListIleAssetsQuery,
  RenameIleBody,
  SaveIleBody,
  TestIleAiConfigBody,
  VersionedSaveIleBody,
} from './classes/validators/IleValidators.js';
import {
  IngestStudentEventsBody,
} from './classes/validators/IleAnalyticsValidators.js';
import { GenerateFromContextBody } from './classes/validators/ContextValidators.js';

export const interactiveExperiencesContainerModules: ContainerModule[] = [
  ileContainerModule,
  sharedContainerModule,
];

export const interactiveExperiencesModuleControllers: Function[] = [IleController];

export const interactiveExperiencesModuleValidators: Function[] = [
  GenerateIleBody,
  SaveIleBody,
  VersionedSaveIleBody,
  RenameIleBody,
  IleIdParam,
  ListIleAssetsQuery,
  IleAiConfigBody,
  TestIleAiConfigBody,
  IngestStudentEventsBody,
  GenerateFromContextBody,
];

export const interactiveExperiencesModuleOptions: RoutingControllersOptions = {
  controllers: interactiveExperiencesModuleControllers,
  middlewares: [],
  defaultErrorHandler: true,
  // Token-based auth, same as the rest of the app.
  authorizationChecker: async function () {
    return true;
  },
  validation: true,
};

export async function setupInteractiveExperiencesContainer(): Promise<void> {
  const container = new Container();
  await container.load(...interactiveExperiencesContainerModules);
  const inversifyAdapter = new InversifyAdapter(container);
  useContainer(inversifyAdapter);

  // Register context providers with the registry, in priority order.
  // More specific providers (YouTube URL detection) MUST register
  // before generic ones (e.g. a future 'website' provider). The
  // registry is a process-wide singleton so each provider is bound
  // once and reused for every request.
  const registry = container.get<import('./context/ContextProviderRegistry.js').ContextProviderRegistry>(
    ILE_TYPES.ContextProviderRegistry,
  );
  registry.register(
    container.get<import('./context/providers/YouTubeContextProvider.js').YouTubeContextProvider>(
      ILE_TYPES.YouTubeContextProvider,
    ),
  );
  registry.register(
    container.get<import('./context/providers/MarkdownContextProvider.js').MarkdownContextProvider>(
      ILE_TYPES.MarkdownContextProvider,
    ),
  );
}