/**
 * The public face of the BCS bridge, namespaced the way the spec spells it:
 * `SuiSchema.bcs(bcsType, expectedType)` and `SuiSchema.decode(codec, bytes)`.
 *
 * The rest of `domain/bcs.ts` (`typeMatches`, `expectedTypeOf`) is machinery
 * `Sui` uses and lives in `sui-effect/internal`.
 *
 * @since 0.1.0
 */
export { bcs, decodeContent as decode } from "./bcs.ts"
