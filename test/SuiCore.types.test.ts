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
