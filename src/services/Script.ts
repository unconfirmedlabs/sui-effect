/**
 * `Script`: the preset for an on-demand script or agent run.
 *
 * A script reads its configuration from the environment, does one job, prints
 * its answer on stdout and exits with a code a wrapper can act on. This module
 * is the wiring for exactly that: one service holding the two tiers and the
 * signer, one entry point that installs signal handlers and maps the `Exit` to
 * a code, and an exported `exitCode` for consumers who prefer
 * `BunRuntime.runMain`.
 *
 * Nothing here imports a platform package: `process` is all a script needs, and
 * even that is injectable so a test can drive the whole thing without exiting.
 *
 * @since 0.1.0
 */
import { Cause, Config, ConfigProvider, Context, Effect, Exit, Fiber, Layer, Logger } from "effect"
import type { NetworkMismatch, SuiError, TransportError } from "../domain/errors.ts"
import { digestOf, SuiError as SuiErrorHelpers } from "../domain/errors.ts"
import type { JournalEntry } from "../domain/journal-entry.ts"
import type { JournalService } from "./Journal.ts"
import { Journal } from "./Journal.ts"
import type { Signer } from "./Signer.ts"
import { fromConfig } from "./Signer.ts"
import type { SuiService } from "./Sui.ts"
import { Sui } from "./Sui.ts"
import type { SuiCoreService } from "./SuiCore.ts"
import { SuiCore } from "./SuiCore.ts"

/** What a script gets from its one service. */
export interface ScriptService {
  /** The opinionated tier, already pointed at the configured network. */
  readonly sui: SuiService
  /** The mechanical tier, for the calls `Sui` does not expose. */
  readonly core: SuiCoreService
  /** The credential read from `SUI_PRIVATE_KEY`. */
  readonly signer: Signer
  /** The network this script is running against. */
  readonly network: string
}

/** What a read-only script gets: everything except a way to sign. */
export interface ScriptReadOnlyService {
  readonly sui: SuiService
  readonly core: SuiCoreService
  readonly network: string
}

const MAINNET_GATE = "SUI_ALLOW_MAINNET"

const configError = (message: string): Config.ConfigError =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }))

/**
 * `SUI_NETWORK`, with no default and with the mainnet gate.
 *
 * There is no default network on purpose: a script that runs against whatever
 * happened to be configured is how a test transaction reaches mainnet. And a
 * script that means mainnet has to say so twice, in `SUI_NETWORK` and in
 * `SUI_ALLOW_MAINNET=1`.
 *
 * Fails with: `ConfigError`.
 */
export const readNetwork: Effect.Effect<string, Config.ConfigError> = Effect.gen(function*() {
  const network = yield* Config.nonEmptyString("SUI_NETWORK")
  if (network !== "mainnet") return network
  const gate = yield* Config.string(MAINNET_GATE).pipe(Config.withDefault(""))
  if (gate === "1" || gate === "true") return network
  return yield* Effect.fail(
    configError(
      `SUI_NETWORK is mainnet: set ${MAINNET_GATE}=1 to let this script touch mainnet.`
    )
  )
})

/** The read-only script service, which has no `signer` in its type. */
export class ScriptReadOnly
  extends Context.Service<ScriptReadOnly, ScriptReadOnlyService>()("@unconfirmed/sui-effect/ScriptReadOnly")
{}

/**
 * The script preset: the two tiers and the signer.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Script } from "@unconfirmed/sui-effect/script"
 *
 * Script.run(Effect.gen(function*() {
 *   const { sui } = yield* Script
 *   yield* Console.log((yield* sui.chainTime).toString())
 * }))
 * ```
 */
export class Script extends Context.Service<Script, ScriptService>()("@unconfirmed/sui-effect/Script") {
  /**
   * Everything a script needs, with `Sui` and `SuiCore` merged in so `Tx.*`
   * works inside a script with no further wiring.
   *
   * Reads `SUI_NETWORK` (required, no default; `mainnet` refused unless
   * `SUI_ALLOW_MAINNET=1`), `SUI_RPC_URL` (optional, defaulted per network) and
   * `SUI_PRIVATE_KEY` (Bech32, through `Config.redacted`).
   *
   * Fails with: `ConfigError`, `NetworkMismatch`, `TransportError`.
   */
  static readonly layer: Layer.Layer<
    Script | Sui | SuiCore,
    Config.ConfigError | NetworkMismatch | TransportError
  > = Layer.unwrap(
    // The gate is read *before* the layer below it exists, so a script pointed
    // at mainnet without `SUI_ALLOW_MAINNET=1` fails without a client having
    // been built and without the chain-identifier call having been made. Read
    // inside `Layer.effect` instead, and the gate would be checked after the
    // connection it exists to prevent.
    Effect.gen(function*() {
      const network = yield* readNetwork
      const signer = yield* fromConfig()
      return Layer.effect(
        Script,
        Effect.gen(function*() {
          const sui = yield* Sui
          const core = yield* SuiCore
          return { sui, core, signer, network }
        })
      ).pipe(Layer.provideMerge(Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCore.layerConfig))))
    })
  )

  /**
   * Like {@link layer}, but over a `Sui` and `SuiCore` the caller already has,
   * which is how a test runs a script against the fake.
   *
   * Fails with: `ConfigError`.
   */
  static readonly layerNoDeps: Layer.Layer<Script, Config.ConfigError, Sui | SuiCore> = Layer
    .effect(
      Script,
      Effect.gen(function*() {
        const network = yield* readNetwork
        const signer = yield* fromConfig()
        const sui = yield* Sui
        const core = yield* SuiCore
        return { sui, core, signer, network }
      })
    )

  /**
   * A script with a signer the caller built, for a credential that does not
   * come from `SUI_PRIVATE_KEY` (a KMS, a wallet, a test key).
   *
   * Fails with: `ConfigError`.
   */
  static readonly layerWithSigner = (
    signer: Signer
  ): Layer.Layer<Script, Config.ConfigError, Sui | SuiCore> =>
    Layer.effect(
      Script,
      Effect.gen(function*() {
        const network = yield* readNetwork
        const sui = yield* Sui
        const core = yield* SuiCore
        return { sui, core, signer, network }
      })
    )

  /**
   * The read-only preset, which has no signer at all: a script built on this
   * cannot sign, and the compiler says so.
   *
   * Fails with: `ConfigError`, `NetworkMismatch`, `TransportError`.
   */
  static readonly layerReadOnly: Layer.Layer<
    ScriptReadOnly | Sui | SuiCore,
    Config.ConfigError | NetworkMismatch | TransportError
  > = Layer.unwrap(
    // As in {@link layer}: the mainnet gate before the client, not after it.
    Effect.gen(function*() {
      const network = yield* readNetwork
      return Layer.effect(
        ScriptReadOnly,
        Effect.gen(function*() {
          const sui = yield* Sui
          const core = yield* SuiCore
          return { sui, core, network }
        })
      ).pipe(Layer.provideMerge(Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCore.layerConfig))))
    })
  )

  /**
   * {@link layerReadOnly} over a `Sui` and `SuiCore` the caller already has,
   * which is how a test exercises the read-only preset against the fake.
   *
   * Fails with: `ConfigError`.
   */
  static readonly layerReadOnlyNoDeps: Layer.Layer<
    ScriptReadOnly,
    Config.ConfigError,
    Sui | SuiCore
  > = Layer.effect(
    ScriptReadOnly,
    Effect.gen(function*() {
      const network = yield* readNetwork
      const sui = yield* Sui
      const core = yield* SuiCore
      return { sui, core, network }
    })
  )

  /** See {@link exitCode}. */
  static readonly exitCode = <A, E>(
    exit: Exit.Exit<A, E>,
    options?: ExitCodeOptions
  ): number => exitCode(exit, options)

  /** See {@link run}. */
  static readonly run = <A, E>(
    effect: Effect.Effect<A, E, Script | Sui | SuiCore>,
    options?: ScriptRunOptions
  ): Promise<number> => run(effect, options)
}

/** Exit codes, on the axis a wrapper script acts on. */
const EXIT = {
  success: 0,
  defect: 1,
  configuration: 2,
  unknown: 3,
  notApplied: 4,
  applied: 5,
  interrupted: 130
} as const

const isConfigError = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  (error as { readonly _tag?: unknown })._tag === "ConfigError"

const hasTag = (error: unknown): error is { readonly _tag: string } =>
  typeof error === "object" && error !== null &&
  typeof (error as { readonly _tag?: unknown })._tag === "string"

const hasOutcomeField = (error: unknown): error is { readonly outcome: string } =>
  typeof error === "object" && error !== null &&
  typeof (error as { readonly outcome?: unknown }).outcome === "string"

/** What {@link exitCode} needs to know beyond the `Exit` itself. */
export interface ExitCodeOptions {
  /**
   * How many submissions the script's journal still holds unresolved.
   *
   * It is what decides a timeout or an interrupt. `Effect.timeout` around a
   * whole submission interrupts it and produces an outer `Cause.TimeoutError`
   * that never went through `Tx.submit`'s own mapping, so the bytes may well be
   * on the wire; the journal is the only thing that knows. With an unresolved
   * entry the exit is 3, "reconcile before doing anything else"; with none it
   * is the ordinary 4 for a timeout and 130 for an interrupt.
   *
   * `Script.run` fills it in from the journal the script ran with. Left out, it
   * is zero, and a timeout is 4 as before.
   */
  readonly unresolved?: number
}

/**
 * The exit code one failure deserves.
 *
 * The axis is what a wrapper can act on: did the transaction apply (5, gas was
 * charged, do not retry), is the outcome unknown (3, reconcile before doing
 * anything else), or did nothing apply (4, safe to retry)? Configuration
 * problems are 2 because no amount of retrying fixes them, a defect is 1, and
 * an interrupt is 130 the way a shell expects — unless the journal says there
 * is a submission outstanding, in which case it is 3, because a wrapper that
 * sees 130 has no reason to go looking for one.
 *
 * An extension error that declares an `outcome` is honoured, so a downstream
 * SDK's own failures land on the same axis. `SchemaError` — what Effect's own
 * `Config.schema` and `Schema.decodeUnknownEffect` fail with — is exit 2 with
 * `ConfigError`, because in a script it can only mean the input a person gave
 * did not fit the schema, and no retry fixes that.
 *
 * An error with a tag this library has never heard of and no `outcome` is
 * *unclassified* and exits 1, the code that also means defect. It deliberately
 * does not follow `SuiError.outcome`, which answers `"unknown"` for the same
 * value: 3 would tell a wrapper there is a transaction to reconcile, and an
 * unrecognised error is not evidence that anything was ever sent. Extensions
 * are told to declare `outcome` on every error precisely so their failures
 * never land here. Never fails.
 */
export const exitCode = <A, E>(
  exit: Exit.Exit<A, E>,
  options?: ExitCodeOptions
): number => {
  if (Exit.isSuccess(exit)) return EXIT.success
  const cause = exit.cause
  const unresolved = options?.unresolved ?? 0
  if (Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)) {
    return unresolved > 0 ? EXIT.unknown : EXIT.interrupted
  }
  if (Cause.hasDies(cause)) return EXIT.defect
  const failure = Cause.findErrorOption(cause)
  return failure._tag === "Some" ? codeOfError(failure.value, unresolved) : EXIT.defect
}

/** The exit code of one error value, the same mapping {@link exitCode} uses. */
const codeOfError = (error: unknown, unresolved: number): number => {
  if (isConfigError(error)) return EXIT.configuration
  if (hasOutcomeField(error)) return codeOfOutcome((error as unknown as HasOutcomeLike).outcome)
  if (!hasTag(error)) return EXIT.defect
  switch (error._tag) {
    case "NetworkMismatch":
      return EXIT.configuration
    case "SubmissionUnknown":
      return EXIT.unknown
    case "ExecutionFailed":
    // An `UnexpectedEffects` is built from an `Executed`: the transaction
    // applied and gas was charged, and only the receipt is missing. Exit 4
    // would tell a wrapper to run the caller's intent a second time.
    case "UnexpectedEffects":
      return EXIT.applied
    // `Effect.timeout` puts a `TimeoutError` in the error channel that is not
    // part of the taxonomy. It used to be mapped unconditionally to "not
    // applied" on the theory that `Tx.submit` turns a timed-out submission into
    // `SubmissionUnknown` — but an `Effect.timeout` wrapped *around* a
    // submission interrupts it from the outside and never reaches that mapping,
    // so the bytes may be on the wire. The journal is what knows.
    case "TimeoutError":
      return unresolved > 0 ? EXIT.unknown : EXIT.notApplied
    case "TransportError":
    case "ObjectNotFound":
    case "ObjectDeleted":
    case "ObjectUnavailable":
    case "TransactionNotFound":
    case "DecodeError":
    case "SimulationFailed":
    case "NotApplied":
    case "SigningError":
    case "BuildError":
    case "PolicyDenied":
    case "JournalError":
    case "GraphQLUnavailable":
    case "ExtensionNotReady":
      return EXIT.notApplied
    case "SchemaError":
      return EXIT.configuration
    default:
      return EXIT.defect
  }
}

interface HasOutcomeLike {
  readonly outcome: string
}

const codeOfOutcome = (outcome: string): number => {
  switch (outcome) {
    case "applied":
      return EXIT.applied
    case "unknown":
      return EXIT.unknown
    default:
      return EXIT.notApplied
  }
}

/** Where a script's diagnostics go, and how it stops. Injectable for tests. */
export interface ScriptRunOptions {
  /**
   * The layer to run the script over. Defaults to {@link Script.layer}, which
   * reads the environment; a test passes `Script.layerNoDeps` over
   * `layerTest(script)` and never touches the network.
   */
  readonly layer?: Layer.Layer<
    Script | Sui | SuiCore,
    Config.ConfigError | NetworkMismatch | TransportError
  >
  /** How the process ends. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void
  /** Where diagnostics go, one line at a time. Defaults to `process.stderr`. */
  readonly stderr?: (line: string) => void
  /** The signal source. Defaults to `process`. */
  readonly signals?: SignalSource
  /** Which signals interrupt the script. Defaults to SIGINT and SIGTERM. */
  readonly signalNames?: ReadonlyArray<string>
}

/** The part of `process` {@link run} uses, so a test can stand in for it. */
export interface SignalSource {
  readonly on: (signal: string, handler: () => void) => unknown
  readonly off?: (signal: string, handler: () => void) => unknown
}

const describeFailure = (error: unknown): ReadonlyArray<string> => {
  if (!hasTag(error)) return [String(error)]
  const lines: Array<string> = []
  if (!isSuiError(error)) {
    const message = "message" in error && typeof error.message === "string"
      ? ` ${error.message}`
      : ""
    return [`${error._tag}${message}`]
  }
  {
    const tagged: SuiError = error
    lines.push(SuiErrorHelpers.describe(tagged))
    const digest = digestOf(tagged)
    if (digest !== undefined) lines.push(`digest: ${digest}`)
    if (tagged._tag === "SubmissionUnknown") {
      if (tagged.signed !== undefined) {
        lines.push(`bytes: ${toBase64(tagged.signed.bytes)}`)
      }
      lines.push(
        "the outcome is unknown: reconcile this digest before sending anything else from this sender"
      )
    }
  }
  return lines
}

const SUI_ERROR_TAGS = new Set([
  "TransportError",
  "ObjectNotFound",
  "ObjectDeleted",
  "ObjectUnavailable",
  "TransactionNotFound",
  "NetworkMismatch",
  "DecodeError",
  "SimulationFailed",
  "ExecutionFailed",
  "SubmissionUnknown",
  "NotApplied",
  "SigningError",
  "BuildError",
  "PolicyDenied",
  "JournalError",
  "UnexpectedEffects",
  "GraphQLUnavailable",
  "ExtensionNotReady"
])

const isSuiError = (error: { readonly _tag: string }): error is SuiError =>
  SUI_ERROR_TAGS.has(error._tag)

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The logger a script runs under: every `Effect.log` on the injected stderr,
 * and nothing on stdout.
 *
 * A script's stdout is its answer — a digest, an object id, a line another
 * program parses — and the default Effect logger writes to `console.log`, which
 * is stdout. One `Effect.logInfo` inside a library an extension depends on
 * would then corrupt the output of every script on the platform. `Logger.map`
 * over `Logger.formatLogFmt` keeps the standard rendering and only changes
 * where it lands.
 */
const stderrLogger = (write: (line: string) => void) =>
  Logger.map(Logger.formatLogFmt, (line) => {
    write(line)
  })

/** The lines describing what this process left on the wire, if anything. */
const unresolvedLines = (entries: ReadonlyArray<JournalEntry>): ReadonlyArray<string> => {
  if (entries.length === 0) return []
  const lines = [
    `${entries.length} submission(s) left unresolved; reconcile them before sending anything else:`
  ]
  for (const entry of entries) {
    lines.push(`unresolved ${entry.digest} (${entry._tag})`)
    if (entry._tag === "Signed" || entry._tag === "Unknown") {
      lines.push(`bytes: ${toBase64(entry.signed.bytes)}`)
    }
  }
  return lines
}

/**
 * Reads the journal **the script actually ran with** for entries that never got
 * an answer.
 *
 * A script interrupted mid-submit has a `Signed` entry and nothing else: no
 * digest in an error, no bytes on stderr, and an exit code that says only that
 * someone pressed Ctrl-C. Printing the entry is the difference between a
 * transaction an operator can reconcile and one nobody can account for.
 *
 * The journal is captured inside the script's own runtime rather than read off
 * the bare reference afterwards: a script that provided a durable `Journal` —
 * which is exactly the script with something to lose — would otherwise have its
 * unresolved entries looked for in the process-wide in-memory default, find
 * none, and print nothing.
 */
const readUnresolved = async (
  journal: JournalService | undefined
): Promise<ReadonlyArray<JournalEntry>> =>
  Effect.runPromise(
    (journal === undefined
      ? Effect.flatMap(Journal, (found) => found.listUnresolved)
      : journal.listUnresolved).pipe(
        Effect.catchCause(() => Effect.succeed<ReadonlyArray<JournalEntry>>([]))
      )
  )

/**
 * Runs a script: builds `Script.layer`, forks the program, interrupts it on
 * SIGINT or SIGTERM so finalizers run, writes one diagnostic line per failure
 * to stderr, and exits with {@link exitCode}.
 *
 * stdout carries only what the script itself printed: the logger is bound to
 * stderr for the whole run, so `Effect.log` from the script or from anything it
 * calls cannot land in the script's output. A `SubmissionUnknown` additionally
 * prints the base64 of the signed bytes and a line saying to reconcile, because
 * those bytes are the durable record a script has.
 *
 * On **every** non-zero exit it also prints whatever the journal the script ran
 * with still holds unresolved, which is the only record of bytes that may be on
 * the wire when a script is killed — or fails — between signing and the answer.
 * That count is also what decides a timeout (3 rather than 4) and an interrupt
 * (3 rather than 130): an `Effect.timeout` around a submission interrupts it
 * from the outside and never reaches `Tx.submit`'s own mapping.
 *
 * **A second SIGINT does nothing.** The handler interrupts the root fiber once;
 * pressing Ctrl-C again while finalizers run is ignored, because the whole
 * point of the first interrupt is to let those finalizers — the journal write
 * that records what was sent, above all — complete. A script whose finalizers
 * hang has to be killed with SIGKILL, which by construction no process can
 * handle.
 *
 * Returns the exit code as well as passing it to `exit`, so a test can inject
 * `exit` and assert on the number without ending the test process.
 */
export const run = async <A, E>(
  effect: Effect.Effect<A, E, Script | Sui | SuiCore>,
  options?: ScriptRunOptions
): Promise<number> => {
  const write = options?.stderr ?? ((line: string) => {
    process.stderr.write(`${line}\n`)
  })
  const stop = options?.exit ?? ((code: number) => {
    process.exit(code)
  })
  const signals = options?.signals ?? process
  const names = options?.signalNames ?? ["SIGINT", "SIGTERM"]

  // The journal the script ran with, captured from inside its own context so an
  // interrupt can report what it left on the wire even when the script provided
  // a durable journal of its own.
  let journal: JournalService | undefined
  const fiber = Effect.runFork(
    Effect.flatMap(Journal, (found) => {
      journal = found
      return effect
    }).pipe(
      Effect.provide(
        Layer.merge(options?.layer ?? Script.layer, Logger.layer([stderrLogger(write)]))
      )
    )
  )
  const handlers = names.map((name) => {
    const handler = () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    signals.on(name, handler)
    return [name, handler] as const
  })

  const exit = await Effect.runPromise(Fiber.await(fiber))
  for (const [name, handler] of handlers) signals.off?.(name, handler)

  let unresolved: ReadonlyArray<JournalEntry> = []
  if (Exit.isFailure(exit)) {
    if (Cause.hasDies(exit.cause)) {
      write(Cause.pretty(exit.cause))
    } else {
      const failure = Cause.findErrorOption(exit.cause)
      if (failure._tag === "Some") {
        for (const line of describeFailure(failure.value)) write(line)
      } else if (Cause.hasInterrupts(exit.cause)) {
        write("interrupted")
      } else {
        write(Cause.pretty(exit.cause))
      }
    }
    // On **every** non-zero exit, not only a defect or an interrupt: a typed
    // failure escaping after a submission — an outer timeout, a preflight that
    // ran too late, an extension error raised past `Tx.submit` — leaves the
    // same record on the wire, and the operator needs the same bytes.
    unresolved = await readUnresolved(journal)
    for (const line of unresolvedLines(unresolved)) write(line)
  }
  const code = exitCode(exit, { unresolved: unresolved.length })
  stop(code)
  return code
}
