/**
 * `@your-org/example-extension`: the public surface.
 *
 * One service, its layers, its errors, its schemas, and the derived Promise
 * registration. Nothing from `upstream.ts` is re-exported: upstream types are
 * narrowed to sui-effect schemas inside the service and never reach a consumer.
 */
export { Escrow, type EscrowFields, type EscrowObject, type EscrowOptions, type EscrowService, type ClaimForError } from "./Escrow.ts"
export { EscrowNotFound, EscrowSettlementUnknown } from "./errors.ts"
export { escrow } from "./extension.ts"
export { ESCROW_PACKAGE, EscrowContent, RECEIPT_TYPE } from "./schema.ts"
