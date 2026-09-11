/**
 * The public face of the BCS bridge, namespaced the way the spec spells it:
 * `SuiSchema.bcs(bcsType, expectedType)`, `SuiSchema.decode(codec, bytes)` and
 * `SuiSchema.matchesType(expected, actual)`.
 *
 * The rest of `domain/bcs.ts` (`expectedTypeOf`) is machinery `Sui` uses and
 * lives in `sui-effect/internal`.
 *
 * @since 0.1.0
 */
export { bcs, decodeContent as decode, typeMatches as matchesType } from "./bcs.ts"
