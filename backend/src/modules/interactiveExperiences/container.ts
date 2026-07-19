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

export const ileContainerModule = new ContainerModule((options) => {
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
  // Controllers
  options.bind(IleController).toSelf().inSingletonScope();
});