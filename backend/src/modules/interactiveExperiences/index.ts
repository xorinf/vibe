import { Container, ContainerModule } from 'inversify';
import {
  RoutingControllersOptions,
  useContainer,
} from 'routing-controllers';
import { sharedContainerModule } from '#root/container.js';
import { InversifyAdapter } from '#root/inversify-adapter.js';
import { ileContainerModule } from './container.js';
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
  IngestStudentEventsQuery,
} from './classes/validators/IleAnalyticsValidators.js';

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
  IngestStudentEventsQuery,
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
}