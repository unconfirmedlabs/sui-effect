/**
 * Internals: everything sui-effect uses to implement itself and everything the
 * tests reach for, none of it part of the public surface.
 *
 * This module is deliberately absent from the package `exports` map. It is
 * importable inside this repository and by nothing else, so an agent reading
 * `src/index.ts` sees exactly the API and nothing that merely happens to be
 * exported. Names here may change in any release.
 *
 * @since 0.1.0
 */
export { bcs, decodeContent, expectedTypeOf, typeMatches } from "./domain/bcs.ts"
export { decodePayload, digestOf, SuiErrorSchema } from "./domain/errors.ts"
export { EXECUTE_INCLUDE, fromTransactionResult } from "./domain/executed.ts"
export { executionReasonOf, makeSuiObject } from "./domain/schemas.ts"
export { OBJECT_INCLUDE, SIMULATE_INCLUDE } from "./services/Sui.ts"
export {
  DefectMarker,
  makeFromClient,
  mapSdkError,
  readSchedule,
  RETRYABLE_GRPC_STATUSES
} from "./services/SuiCore.ts"
