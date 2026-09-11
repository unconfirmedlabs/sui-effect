/**
 * sui-effect: an opinionated Effect v4 layer over `@mysten/sui`.
 *
 * Two tiers: `SuiCore` mirrors the SDK method for method, `Sui` makes the
 * opinionated decisions. Every public function states its error union in words,
 * every failure is a `Schema.TaggedError`, and every boundary decodes through
 * `Schema`.
 *
 * @since 0.1.0
 */
export * from "./domain/errors.ts"
export * from "./domain/executed.ts"
export * from "./domain/schemas.ts"
export { Sui, type Recipe, type SuiService, OBJECT_INCLUDE, SIMULATE_INCLUDE } from "./services/Sui.ts"
export {
  mapSdkError,
  defaultGrpcUrl,
  DefectMarker,
  makeFromClient,
  readSchedule,
  SuiCore,
  type ObjectLookupError,
  type SimulationLookupError,
  type SuiCoreError,
  type SuiCoreService,
  type SuiGrpcLayerOptions,
  type TransactionLookupError
} from "./services/SuiCore.ts"

/**
 * The BCS bridge, namespaced the way the spec spells it:
 * `SuiSchema.bcs(bcsType, expectedType)`.
 */
export * as SuiSchema from "./domain/bcs.ts"
