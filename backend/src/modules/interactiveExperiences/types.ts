// DI symbols for the interactiveExperiences module.
// Convention: one Symbol.for per injectable. Module-local, no cross-module
// coupling through these symbols — services that need other modules inject
// them via their own TYPES const.

const TYPES = {
  IleRepository: Symbol.for('IleRepository'),
  IleGenerationService: Symbol.for('IleGenerationService'),
  IleService: Symbol.for('IleService'),
  IleSseService: Symbol.for('IleSseService'),
  IleAiConfigRepository: Symbol.for('IleAiConfigRepository'),
  IleAiConfigService: Symbol.for('IleAiConfigService'),
  IleAssetRepository: Symbol.for('IleAssetRepository'),
  IleAssetStorageService: Symbol.for('IleAssetStorageService'),
  IleAssetService: Symbol.for('IleAssetService'),
  IleStudentProgressRepository: Symbol.for('IleStudentProgressRepository'),
  IleAnalyticsService: Symbol.for('IleAnalyticsService'),
};

export { TYPES as ILE_TYPES };