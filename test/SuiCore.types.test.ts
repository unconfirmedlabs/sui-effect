import { expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { Effect } from "effect"
import type { SuiCoreService } from "../src/services/SuiCore.ts"

/** Compile-time assertion helper. */
const assertNever = <_T extends never>(): true => true

/**
 * Every key of `SuiClientTypes.TransportMethods` must be a member of the
 * service. This is the completeness test from the spec: if the SDK adds a
 * transport method, this file stops compiling.
 */
type Missing = Exclude<keyof SuiClientTypes.TransportMethods, keyof SuiCoreService>

/** The four concrete conveniences `CoreClient` adds on top of the contract. */
type MissingConveniences = Exclude<
  "getObject" | "getDynamicObjectField" | "waitForTransaction" | "signAndExecuteTransaction",
  keyof SuiCoreService
>

test("SuiCore covers every TransportMethods key", () => {
  expect(assertNever<Missing>()).toBe(true)
  expect(assertNever<MissingConveniences>()).toBe(true)
})

/** True when `A` is assignable to `B`, as a value the test can assert on. */
const assignable = <_A extends _B, _B>(): true => true

test("Include generics are preserved on every method that takes one", () => {
  const service = null as unknown as SuiCoreService

  type Objects = Effect.Success<ReturnType<typeof service.getObjects<{ content: true }>>>
  expect(assignable<Exclude<Objects["objects"][number], Error>["content"], Uint8Array>()).toBe(true)
  type BareObjects = Effect.Success<ReturnType<typeof service.getObjects>>
  expect(assignable<Exclude<BareObjects["objects"][number], Error>["content"], undefined>()).toBe(
    true
  )

  type Owned = Effect.Success<ReturnType<typeof service.listOwnedObjects<{ content: true }>>>
  expect(assignable<Owned["objects"][number]["content"], Uint8Array>()).toBe(true)
  type BareOwned = Effect.Success<ReturnType<typeof service.listOwnedObjects>>
  expect(assignable<BareOwned["objects"][number]["content"], undefined>()).toBe(true)

  type Transaction = Effect.Success<ReturnType<typeof service.getTransaction<{ events: true }>>>
  type Events = Extract<Transaction, { $kind: "Transaction" }>["Transaction"]["events"]
  expect(assignable<Events, ReadonlyArray<SuiClientTypes.Event>>()).toBe(true)
  type BareTransaction = Effect.Success<ReturnType<typeof service.getTransaction>>
  type BareEvents = Extract<BareTransaction, { $kind: "Transaction" }>["Transaction"]["events"]
  expect(assignable<BareEvents, undefined>()).toBe(true)

  type Executed = Effect.Success<ReturnType<typeof service.executeTransaction<{ effects: true }>>>
  type Effects = Extract<Executed, { $kind: "Transaction" }>["Transaction"]["effects"]
  expect(assignable<Effects, SuiClientTypes.TransactionEffects>()).toBe(true)

  type Waited = Effect.Success<ReturnType<typeof service.waitForTransaction<{ effects: true }>>>
  type WaitedEffects = Extract<Waited, { $kind: "Transaction" }>["Transaction"]["effects"]
  expect(assignable<WaitedEffects, SuiClientTypes.TransactionEffects>()).toBe(true)

  type Simulated = Effect.Success<
    ReturnType<typeof service.simulateTransaction<{ commandResults: true }>>
  >
  expect(assignable<Simulated["commandResults"], ReadonlyArray<SuiClientTypes.CommandResult>>())
    .toBe(true)
  type BareSimulated = Effect.Success<ReturnType<typeof service.simulateTransaction>>
  expect(assignable<BareSimulated["commandResults"], undefined>()).toBe(true)

  type Listed = Effect.Success<ReturnType<typeof service.listTransactions<{ effects: true }>>>
  type ListedEffects = Extract<
    Listed["transactions"][number],
    { $kind: "Transaction" }
  >["Transaction"]["effects"]
  expect(assignable<ListedEffects, SuiClientTypes.TransactionEffects>()).toBe(true)
})

test("Include generics are preserved", () => {
  const service = null as unknown as SuiCoreService
  type ObjectResult = Effect.Success<ReturnType<typeof service.getObject<{ content: true }>>>
  type Content = ObjectResult["object"]["content"]
  const contentIsBytes: Content extends Uint8Array ? true : false = true
  expect(contentIsBytes).toBe(true)

  type BareResult = Effect.Success<ReturnType<typeof service.getObject>>
  const bareContentIsUndefined: BareResult["object"]["content"] extends undefined ? true : false =
    true
  expect(bareContentIsUndefined).toBe(true)
})
