import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SuiGrpcClient } from "@mysten/sui/grpc"

describe("scaffold", () => {
  test("effect resolves and runs", async () => {
    const value = await Effect.runPromise(Effect.succeed(1))
    expect(value).toBe(1)
  })

  test("the sui grpc client constructor resolves", () => {
    expect(typeof SuiGrpcClient).toBe("function")
  })
})
