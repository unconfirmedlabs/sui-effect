/**
 * The public face of the BCS bridge, namespaced the way the spec spells it:
 * `SuiSchema.bcs(bcsType, expectedType)`.
 *
 * The rest of `domain/bcs.ts` (`decodeContent`, `typeMatches`,
 * `expectedTypeOf`) is machinery `Sui` uses and lives in `sui-effect/internal`.
 *
 * @since 0.1.0
 */
export { bcs } from "./bcs.ts"
