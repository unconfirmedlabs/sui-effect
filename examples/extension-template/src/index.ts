/**
 * `@your-org/example-extension`: the public surface.
 *
 * One service, its layers, its errors, its schemas, and the derived Promise
 * registration. Nothing from `upstream.ts` is re-exported: upstream types are
 * narrowed to sui-effect schemas inside the service and never reach a consumer.
 */
export {
  DEPLOYMENTS,
  Escrow,
  type ClaimForError,
  type EscrowDeployment,
  type EscrowFields,
  type EscrowObject,
  type EscrowOptions,
  type EscrowService
} from "./Escrow.ts"
export { EscrowNotFound, EscrowSettlementUnknown, EscrowUnsupportedNetwork } from "./errors.ts"
export { escrow, type EscrowRegistrationOptions } from "./extension.ts"
export {
  Platform,
  platform,
  type PlatformOptions,
  type PlatformRegistrationOptions,
  type PlatformService
} from "./Platform.ts"
export {
  ESCROW_PACKAGE,
  EscrowContent,
  escrowType,
  receiptType,
  Settlement,
  SettlementContent
} from "./schema.ts"
