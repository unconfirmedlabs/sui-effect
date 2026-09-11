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
import { Cause, Config, ConfigProvider, Context, Effect, Exit, Fiber, Layer } from "effect"
import type { NetworkMismatch, SuiError, TransportError } from "../domain/errors.ts"
import { digestOf, SuiError as SuiErrorHelpers } from "../domain/errors.ts"
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
  extends Context.Service<ScriptReadOnly, ScriptReadOnlyService>()("sui-effect/ScriptReadOnly")
{}

/**
 * The script preset: the two tiers and the signer.
 *
 * @example
 * ```ts
 * import { Console, Effect } from "effect"
 * import { Script } from "sui-effect/script"
 *
 * Script.run(Effect.gen(function*() {
 *   const { sui } = yield* Script
 *   yield* Console.log((yield* sui.chainTime).toString())
 * }))
 * ```
 */
export class Script extends Context.Service<Script, ScriptService>()("sui-effect/Script") {
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
  > = Layer.effect(
    Script,
    Effect.gen(function*() {
      const network = yield* readNetwork
      const signer = yield* fromConfig()
      const sui = yield* Sui
      const core = yield* SuiCore
      return { sui, core, signer, network }
    })
  ).pipe(Layer.provideMerge(Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCore.layerConfig))))

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
  > = Layer.effect(
    ScriptReadOnly,
    Effect.gen(function*() {
      const network = yield* readNetwork
      const sui = yield* Sui
      const core = yield* SuiCore
      return { sui, core, network }
    })
  ).pipe(Layer.provideMerge(Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCore.layerConfig))))

  /** See {@link exitCode}. */
  static readonly exitCode = <A, E>(exit: Exit.Exit<A, E>): number => exitCode(exit)

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

/**
 * The exit code one failure deserves.
 *
 * The axis is what a wrapper can act on: did the transaction apply (5, gas was
 * charged, do not retry), is the outcome unknown (3, reconcile before doing
 * anything else), or did nothing apply (4, safe to retry)? Configuration
 * problems are 2 because no amount of retrying fixes them, a defect is 1, and
 * an interrupt is 130 the way a shell expects.
 *
 * An extension error that declares an `outcome` is honoured, so a downstream
 * SDK's own failures land on the same axis. Never fails.
 */
export const exitCode = <A, E>(exit: Exit.Exit<A, E>): number => {
  if (Exit.isSuccess(exit)) return EXIT.success
  const cause = exit.cause
  if (Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)) {
    return EXIT.interrupted
  }
  if (Cause.hasDies(cause)) return EXIT.defect
  const failure = Cause.findErrorOption(cause)
  return failure._tag === "Some" ? codeOfError(failure.value) : EXIT.defect
}

/** The exit code of one error value, the same mapping {@link exitCode} uses. */
const codeOfError = (error: unknown): number => {
  if (isConfigError(error)) return EXIT.configuration
  if (hasOutcomeField(error)) return codeOfOutcome((error as unknown as HasOutcomeLike).outcome)
  if (!hasTag(error)) return EXIT.defect
  switch (error._tag) {
    case "NetworkMismatch":
      return EXIT.configuration
    case "SubmissionUnknown":
      return EXIT.unknown
    case "ExecutionFailed":
      return EXIT.applied
    // `Effect.timeout` puts a `TimeoutError` in the error channel that is not
    // part of the taxonomy; a timeout that reached here was not a submission,
    // because `Tx.submit` turns those into `SubmissionUnknown`.
    case "TimeoutError":
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
    case "UnexpectedEffects":
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
  "UnexpectedEffects"
])

const isSuiError = (error: { readonly _tag: string }): error is SuiError =>
  SUI_ERROR_TAGS.has(error._tag)

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Runs a script: builds `Script.layer`, forks the program, interrupts it on
 * SIGINT or SIGTERM so finalizers run, writes one diagnostic line per failure
 * to stderr, and exits with {@link exitCode}.
 *
 * stdout carries only what the script itself printed. A `SubmissionUnknown`
 * additionally prints the base64 of the signed bytes and a line saying to
 * reconcile, because those bytes are the durable record a script has.
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

  const fiber = Effect.runFork(effect.pipe(Effect.provide(options?.layer ?? Script.layer)))
  const handlers = names.map((name) => {
    const handler = () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    signals.on(name, handler)
    return [name, handler] as const
  })

  const exit = await Effect.runPromise(Fiber.await(fiber))
  for (const [name, handler] of handlers) signals.off?.(name, handler)

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
  }
  const code = exitCode(exit)
  stop(code)
  return code
}
