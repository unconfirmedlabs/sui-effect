/**
 * Shared fixtures for the unit tests: keys, a scripted `SuiCore` with
 * per-test stubs of the methods a test is about, and bytes built offline.
 *
 * A stub replaces one `SuiCore` method with a scripted answer or fault; it
 * never models what a node would do with a transaction.
 */
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { type Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { TransportError } from "../src/domain/errors.ts"
import type { Digest } from "../src/domain/schemas.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import type { SuiCoreService } from "../src/services/SuiCore.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_EPOCH,
  type FakeExecution,
  FakeOutcome,
  type FakeScript,
  ScriptedSuiCore,
  SuiTest,
  testSubmitConfig,
  transactionResultOf
} from "../src/testing.ts"

export const keypair = (seed: number) => Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(seed))
export const signer = fromKeypair(keypair(1))
export const sponsor = fromKeypair(keypair(2))
export const stranger = fromKeypair(keypair(3))
export const CHAIN = DEFAULT_CHAIN_ID
export const EPOCH = DEFAULT_EPOCH
export const SUI = "0x2::sui::SUI"

/** Enough SUI in an address balance to pay any budget the SDK resolver computes over the script. */
export const funded = (...owners: ReadonlyArray<string>): NonNullable<FakeScript["addressBalances"]> =>
  owners.map((owner) => ({ owner, amount: 10_000_000_000n }))

/** A plain success, and the script lifecycle tests start from: funded parties, simulate and execute succeed. */
export const ok = FakeOutcome.succeed()
export const script = (extra: FakeScript = {}): FakeScript => ({
  addressBalances: funded(signer.address, sponsor.address),
  simulate: [ok],
  execute: [ok],
  ...extra
})

/** Overrides of individual `SuiCore` methods; anything not named answers from the script. */
export type Stubs = Partial<SuiCoreService>

/**
 * The real `Sui` over the scripted `SuiCore`, with `stubs` in place of the
 * methods they name, `testSubmitConfig` in force, and the responder's handle
 * for `SuiTest`.
 */
export const layer = (extra: FakeScript = {}, stubs: Stubs = {}) => {
  const handle = Layer.effect(ScriptedSuiCore, ScriptedSuiCore.make(script(extra)))
  const core = Layer.effect(SuiCore, Effect.map(ScriptedSuiCore, (h) => ({ ...h.core, ...stubs })))
  return Sui.layerNoDeps.pipe(
    Layer.provideMerge(core),
    Layer.provideMerge(handle),
    Layer.provideMerge(SubmitConfig.layer(testSubmitConfig))
  )
}

type Services = Sui | SuiCore | ScriptedSuiCore

/** Runs `effect` over {@link layer} with a fresh memory journal and `TestClock`. */
export const run = <A, E>(effect: Effect.Effect<A, E, Services>, extra: FakeScript = {}, stubs: Stubs = {}): Promise<A> =>
  effect.pipe(SuiTest.provide(layer(extra, stubs)), Effect.runPromise)

/** `effect` in a fiber while the `TestClock` moves an hour on, for anything that waits or retries. */
export const adjusted = <A, E, R>(effect: Effect.Effect<A, E, R>, by: Duration.Input = "1 hour") =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(effect)
    yield* TestClock.adjust(by)
    return yield* Fiber.join(fiber)
  })

/** The same, answering the failure. */
export const fail = <A, E>(effect: Effect.Effect<A, E, Services>, extra: FakeScript = {}, stubs: Stubs = {}): Promise<E> =>
  run(Effect.flip(effect), extra, stubs)

/** A stub answering each call with the next answer, the last repeating; `calls` records the options. */
export const sequence = <A, E>(answers: ReadonlyArray<() => Effect.Effect<A, E>>) => {
  let next = 0
  const calls: Array<unknown> = []
  // Suspended: `Sui` builds some of its effects once, at construction.
  const stub = (options?: unknown) =>
    Effect.suspend(() => {
      calls.push(options)
      return answers[Math.min(next++, answers.length - 1)]!()
    })
  // Each stub stands in for one `SuiCore` method; its options and answer are that method's.
  return { stub: stub as never, calls }
}

export const transport = (method: string, status: string, retryable = false) =>
  new TransportError({ method, retryable, status, cause: `scripted ${status}` })

/** The SDK result of a transaction with this digest, as a stub returns it. */
export const resultOf = (digest: string, execution: FakeExecution = {}, failed?: SuiClientTypes.ExecutionError) =>
  transactionResultOf(digest, failed === undefined ? FakeOutcome.succeed(execution) : FakeOutcome.failWith(failed, execution))

/** A pinned owned object and a gas coin, for reconcile tests. */
export const OWNED = { objectId: `0x${"a1".repeat(32)}`, version: "3", digest: "11111111111111111111111111111111" }
export const GAS = { objectId: `0x${"9a".repeat(32)}`, version: "5", digest: "11111111111111111111111111111111" }

/**
 * Fully resolved transaction bytes, built offline: a transfer of `inputs`
 * (`[OWNED]` by default) to the stranger, gas from `payment` (`[GAS]` by
 * default; `[]` for an address balance), valid in epochs
 * `minEpoch..maxEpoch` on `chain`.
 */
export const bytes = (opts: {
  readonly sender?: string
  readonly gasOwner?: string
  readonly payment?: ReadonlyArray<typeof GAS>
  readonly inputs?: ReadonlyArray<typeof OWNED>
  readonly minEpoch?: bigint
  readonly maxEpoch?: bigint
  readonly chain?: string
  readonly nonce?: number
} = {}): Promise<Uint8Array> => {
  const tx = new Transaction()
  tx.setSender(opts.sender ?? signer.address)
  if (opts.gasOwner !== undefined) tx.setGasOwner(opts.gasOwner)
  tx.setGasPrice(1000)
  tx.setGasBudget(5_000_000)
  tx.setGasPayment([...(opts.payment ?? [GAS])])
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(opts.minEpoch ?? EPOCH),
      maxEpoch: String(opts.maxEpoch ?? EPOCH + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: opts.chain ?? CHAIN,
      nonce: opts.nonce ?? 7
    }
  })
  const inputs = opts.inputs ?? [OWNED]
  if (inputs.length > 0) tx.transferObjects(inputs.map((ref) => tx.objectRef(ref)), stranger.address)
  else tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] })
  return tx.build()
}

export const digestOf = (built: Uint8Array): Digest => TransactionDataBuilder.getDigestFromBytes(built) as Digest
