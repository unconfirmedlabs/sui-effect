// A resumable indexer: commit each page's items together with its `endCursor`, and start
// again from the last committed cursor. The tail never ends; it polls once caught up.
//
// Pruning: a node keeps a bounded history. A cursor it has pruned past fails the tail with a
// non-retryable `TransportError` (gRPC `OUT_OF_RANGE`): resume from a node that still holds it.
// A filtered tail keeps its cursor near the head while nothing matches (it emits an empty page
// to say so), so commit empty pages too, or an idle indexer falls behind the pruning line.
import { Effect, Stream } from "effect"
import { type EventEntry, Sui } from "../../src/index.ts"

const POSTED = "0x00000000000000000000000000000000000000000000000000000000000000b1::board::Posted"

export const indexPosts = <E>(
  after: string | null,
  commit: (items: ReadonlyArray<EventEntry>, cursor: string | null) => Effect.Effect<void, E>
) =>
  Stream.unwrap(Effect.map(Sui, (sui) =>
    sui.tailEventPages({ eventType: POSTED }, { after }).pipe(
      // One transaction in your store: the rows and the cursor, or neither.
      Stream.mapEffect((page) => commit(page.items, page.endCursor))
    )))
