// A resumable indexer: page through `sui.core.listEvents`, commit each page's events together
// with its `endCursor`, and start again from the last committed cursor. Once caught up it polls.
// (`sui.tailEvents` is the same loop when nothing has to be committed: it never ends, and a
// restart begins again from its `after`.)
//
// Pruning: a node keeps a bounded history. A cursor it has pruned past fails with a
// non-retryable `TransportError` (gRPC `OUT_OF_RANGE`): resume from a node that still holds it.
import type { SuiClientTypes } from "@mysten/sui/client"
import { Effect } from "effect"
import { Sui } from "../../src/index.ts"

const POSTED = "0x00000000000000000000000000000000000000000000000000000000000000b1::board::Posted"

export const indexPosts = <E>(
  after: string | null,
  commit: (events: ReadonlyArray<SuiClientTypes.EventEntry>, cursor: string | null) => Effect.Effect<void, E>
) =>
  Effect.gen(function*() {
    const sui = yield* Sui
    let cursor = after
    while (true) {
      const page = yield* sui.core.listEvents({ filter: { eventType: POSTED }, after: cursor })
      if (page.events.length > 0) {
        cursor = page.endCursor ?? cursor
        // One transaction in your store: the rows and the cursor, or neither.
        yield* commit(page.events, cursor)
      }
      if (!page.hasNextPage) yield* Effect.sleep("1 second")
    }
  })
