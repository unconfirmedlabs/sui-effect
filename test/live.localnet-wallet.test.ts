/**
 * The 0.5.0 wallet core against a **localnet**: every signer kind a wallet
 * holds (DESIGN §18, §19), the sponsored and dapp flows through `Tx.prepare`
 * and the intent (§6, §17), and the durable journal over a portable store
 * (§20). The unit tests prove each signer produces a signature the SDK
 * verifies; only a validator says it accepts one, and only a node says what a
 * sponsored or dapp transaction's effects are.
 *
 * Gated behind `SUI_LOCALNET=1`, like `test/live.localnet.test.ts`:
 *
 * ```bash
 * sui start --with-faucet --force-regenesis &
 * SUI_LOCALNET=1 bun test test/live.localnet-wallet.test.ts
 * ```
 *
 * Every test uses fresh accounts. What is **not** proven here: a zkLogin
 * signature a validator accepts (that needs a prover and the issuer's JWK), a
 * real WebAuthn authenticator or browser, a real Wallet Standard extension, and
 * a real IndexedDB — those are stand-ins (`test/account-signers.test.ts`,
 * `test/storage-fakes.ts`).
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { computeZkLoginAddressFromSeed, genAddressSeed } from "@mysten/sui/zklogin"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { DateTime, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { KeyValueStore } from "effect/persistence"
import { JournalError, type PolicyDenied, SigningError } from "../src/domain/errors.ts"
import { Intent } from "../src/domain/intent.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { KeyError } from "../src/domain/keys.ts"
import { CoinType, SuiAddress } from "../src/domain/schemas.ts"
import { layerKeyValueStore } from "../src/journal.ts"
import { DEFAULT_ITERATIONS, DEFAULT_PREFIX, Keystore } from "../src/keystore.ts"
import type { PasskeyProvider } from "../src/services/AccountSigners.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair, Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { type Prepared, type Signed, Tx } from "../src/services/Tx.ts"
import { layerIndexedDb } from "../src/storage.ts"
import { verifySponsored } from "../src/tx.ts"
import { makeFakeIndexedDb } from "./storage-fakes.ts"

const LOCALNET = process.env["SUI_LOCALNET"] === "1"
const BASE_URL = process.env["SUI_LOCALNET_URL"] ?? "http://127.0.0.1:9000"
const FAUCET = process.env["SUI_LOCALNET_FAUCET"] ?? "http://127.0.0.1:9123"
const MINUTE = 60_000
const ONE_SUI = 1_000_000_000n

/** The SDK client a party outside the library uses: a sponsor backend, a dapp, a raw send. */
const grpc = new SuiGrpcClient({ network: "localnet", baseUrl: BASE_URL })

/** Calls the node served through `SuiCore`, counted while a test runs. */
interface Counts {
  simulates: number
  executes: number
}

/**
 * Runs an effect against the localnet over a `SuiCore` that counts its
 * `simulateTransaction` and `executeTransaction` calls, with a journal
 * (in-memory by default) and any extra layer the test needs.
 */
const node = <A, E, X = never>(
  effect: Effect.Effect<A, E, Sui | SuiCore | X>,
  opts: {
    readonly counts?: Counts
    readonly journal?: Layer.Layer<never, JournalError>
    readonly extra?: Layer.Layer<X>
  } = {}
): Promise<A> => {
  const counts = opts.counts ?? { simulates: 0, executes: 0 }
  const core = Layer.effect(
    SuiCore,
    Effect.gen(function*() {
      const inner = yield* SuiCore
      return {
        ...inner,
        simulateTransaction: ((options: Parameters<typeof inner.simulateTransaction>[0]) => {
          counts.simulates += 1
          return inner.simulateTransaction(options)
        }) as typeof inner.simulateTransaction,
        executeTransaction: ((options: Parameters<typeof inner.executeTransaction>[0]) => {
          counts.executes += 1
          return inner.executeTransaction(options)
        }) as typeof inner.executeTransaction
      }
    })
  ).pipe(Layer.provide(SuiCore.layerGrpc({ network: "localnet", baseUrl: BASE_URL })))
  const layer = Layer.mergeAll(
    Sui.layerNoDeps.pipe(Layer.provideMerge(core)),
    opts.journal ?? Journal.layerMemory,
    (opts.extra ?? Layer.empty) as Layer.Layer<X>
  )
  return Effect.runPromise(Effect.provide(effect, layer, { local: true }))
}

/** The faucet's coins on `address`, once a read sees them. */
const faucet = (address: SuiAddress) =>
  Effect.gen(function*() {
    yield* Effect.promise(() => requestSuiFromFaucetV2({ host: FAUCET, recipient: address }))
    const sui = yield* Sui
    yield* Effect.retry(
      Effect.flatMap(sui.getBalance(address), (value) =>
        value.coinBalance > 0n ? Effect.void : Effect.fail("not visible yet" as const)),
      { schedule: Schedule.spaced("250 millis"), times: 40 }
    )
  })

/** Faucet, then fold — signed by `signer` — so gas comes from the address balance. */
const fundAndFold = (signer: Signer) =>
  Effect.gen(function*() {
    yield* faucet(signer.address)
    yield* Tx.foldCoins({ signer })
  })

const balanceOf = (address: SuiAddress) =>
  Effect.map(Effect.flatMap(Sui, (sui) => sui.getBalance(address)), (balance) => ({
    coinBalance: balance.coinBalance as bigint,
    addressBalance: balance.addressBalance as bigint
  }))

const gasPaymentOf = (bytes: Uint8Array) => TransactionDataBuilder.fromBytes(bytes).gasData.payment?.length ?? -1

/** Polls the node, outside the library, until a digest is readable (two minutes at most). */
const visible = async (digest: string) => {
  const start = Date.now()
  while (Date.now() - start < 2 * MINUTE) {
    try {
      return await grpc.core.getTransaction({ digest })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`${digest} never became visible`)
}

const stranger = () => SuiAddress.make(new Ed25519Keypair().toSuiAddress())

/** A list word that, put last, breaks the phrase's checksum: a one-word typo. */
const oneWordOff = (phrase: string): string => {
  const words = phrase.split(" ")
  const other = wordlist.find((word) =>
    word !== words.at(-1) && !validateMnemonic([...words.slice(0, -1), word].join(" "), wordlist)
  )
  if (other === undefined) throw new Error("no checksum-breaking word found")
  return [...words.slice(0, -1), other].join(" ")
}

// ---------------------------------------------------------------------------
// A software P-256 authenticator (as in test/account-signers.test.ts).
// ---------------------------------------------------------------------------

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))

const derOf = (compact: Uint8Array) => {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    const body = (trimmed[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...trimmed]) : trimmed
    return [0x02, body.length, ...body]
  }
  const sequence = [...integer(compact.slice(0, 32)), ...integer(compact.slice(32))]
  return Uint8Array.from([0x30, sequence.length, ...sequence])
}

const arrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

const softwareAuthenticator = (key: Secp256r1Keypair, prompts: { count: number }): PasskeyProvider => ({
  create: () => Promise.reject(new Error("not used")),
  get: async (challenge) => {
    prompts.count += 1
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: "webauthn.get",
      challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      origin: "https://miso.test"
    }))
    const authenticatorData = new Uint8Array(37).fill(1)
    const payload = Uint8Array.from([...authenticatorData, ...(await sha256(clientDataJSON))])
    return {
      response: {
        authenticatorData: arrayBuffer(authenticatorData),
        clientDataJSON: arrayBuffer(clientDataJSON),
        signature: arrayBuffer(derOf(await key.sign(payload)))
      }
    }
  }
})

// ---------------------------------------------------------------------------
// A Wallet Standard wallet backed by a keypair.
// ---------------------------------------------------------------------------

const keypairWallet = (key: Ed25519Keypair, mode: "honest" | "rebuild-differently") => ({
  name: "Keypair Wallet",
  features: {
    "sui:signTransaction": {
      version: "2.0.0",
      signTransaction: async (input: { transaction: { toJSON(): Promise<string> } }) => {
        // What a wallet does with a dapp's request: rebuild it from its JSON.
        const tx = Transaction.from(await input.transaction.toJSON())
        if (mode === "rebuild-differently") tx.setGasBudget(BigInt(tx.getData().gasData.budget ?? 0) + 1n)
        const bytes = await tx.build()
        return { bytes: toBase64(bytes), signature: (await key.signTransaction(bytes)).signature }
      }
    },
    "sui:signPersonalMessage": {
      version: "1.1.0",
      signPersonalMessage: (input: { message: Uint8Array }) => key.signPersonalMessage(input.message)
    }
  }
})

const walletAccount = (key: Ed25519Keypair) => ({
  address: key.toSuiAddress(),
  publicKey: key.getPublicKey().toRawBytes(),
  chains: ["sui:localnet"],
  features: ["sui:signTransaction", "sui:signPersonalMessage"]
})

// ---------------------------------------------------------------------------
// Sponsorship: what a sponsor backend does with a sender's transaction kind.
// ---------------------------------------------------------------------------

/** A sender's harmless transaction: one pure Move call, no coin of its own. */
const recordId = (owner: SuiAddress) => (tx: Transaction) => {
  tx.moveCall({ target: "0x2::object::id_from_address", arguments: [tx.pure.address(owner)] })
}

const kindOf = (recipe: (tx: Transaction) => void) => {
  const tx = new Transaction()
  recipe(tx)
  return tx.build({ client: grpc, onlyTransactionKind: true })
}

/**
 * The sponsor backend, written against the SDK alone: the kind, the sender,
 * itself as gas owner paying from its address balance, a two-epoch window on
 * this chain, and its signature over the bytes.
 */
const sponsorBackend = async (
  sponsor: Ed25519Keypair,
  kind: Uint8Array,
  sender: string,
  tamper?: "sender" | "kind"
) => {
  const tx = Transaction.fromKind(kind)
  if (tamper === "kind") {
    tx.moveCall({ target: "0x2::object::id_from_address", arguments: [tx.pure.address(sponsor.toSuiAddress())] })
  }
  tx.setSender(tamper === "sender" ? stranger() : sender)
  tx.setGasOwner(sponsor.toSuiAddress())
  tx.setGasPayment([])
  const { systemState } = await grpc.core.getCurrentSystemState()
  const { chainIdentifier } = await grpc.core.getChainIdentifier()
  const epoch = BigInt(systemState.epoch)
  tx.setExpiration({
    ValidDuring: {
      minEpoch: epoch.toString(),
      maxEpoch: (epoch + 1n).toString(),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: Math.floor(Math.random() * 2 ** 32)
    }
  })
  const bytes = await tx.build({ client: grpc })
  return { bytes, signature: (await sponsor.signTransaction(bytes)).signature }
}

/** A signer that counts its transaction signatures. */
const countingSigns = (signer: Signer, counter: { count: number }): Signer => ({
  ...signer,
  signTransaction: (bytes) =>
    Effect.suspend(() => {
      counter.count += 1
      return signer.signTransaction(bytes)
    })
})

const noClaims = (summary: string): Intent => ({
  summary,
  author: "user",
  claims: { outflows: [], recipients: [], objects: [] }
})

// ---------------------------------------------------------------------------
// zkLogin: a session with placeholder proof points but a real address seed.
// ---------------------------------------------------------------------------

const ISS = "https://accounts.google.com"
const base64Url = (text: string) =>
  toBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const zkSession = (maxEpoch: bigint, salt: bigint) => {
  const addressSeed = genAddressSeed(salt, "sub", `user-${salt}`, "client-1").toString()
  return {
    address: SuiAddress.make(computeZkLoginAddressFromSeed(BigInt(addressSeed), ISS, false)),
    maxEpoch,
    expiresAt: Date.now() + 30 * MINUTE,
    proof: {
      proofPoints: { a: ["1", "2", "1"], b: [["1", "0"], ["1", "0"], ["1", "0"]], c: ["1", "2", "1"] },
      issBase64Details: { value: base64Url(`"iss":"${ISS}",`), indexMod4: 0 },
      headerBase64: base64Url("{\"alg\":\"RS256\"}"),
      addressSeed
    }
  }
}

const currentEpoch = Effect.map(
  Effect.flatMap(SuiCore, (core) => core.getCurrentSystemState({})),
  (state) => BigInt(state.systemState.epoch)
)

describe.skipIf(!LOCALNET)("the wallet core on localnet, with SUI_LOCALNET=1", () => {
  for (const scheme of ["ED25519", "Secp256k1", "Secp256r1"] as const) {
    test(
      `1. Signer.fromMnemonic (${scheme}): a generated phrase executes; one word off is refused before anything is built`,
      async () => {
        const counts: Counts = { simulates: 0, executes: 0 }
        const phrase = await Effect.runPromise(Signer.generateMnemonic())
        const { executed, received, payment } = await node(Effect.gen(function*() {
          const signer = yield* Signer.fromMnemonic(phrase, { scheme })
          expect(signer.scheme).toBe(scheme)
          yield* fundAndFold(signer)
          const friend = stranger()
          let payment = -1
          const executed = yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), {
            signer,
            onSigned: (signed) => Effect.sync(() => {
              payment = gasPaymentOf(signed.bytes)
            })
          })
          return { executed, received: yield* balanceOf(friend), payment }
        }), { counts })
        expect(executed.effects.status.success).toBe(true)
        expect(payment).toBe(0)
        expect(received.addressBalance).toBe(ONE_SUI)

        const before = { ...counts }
        const typo = oneWordOff(Redacted.value(phrase))
        const error = await node(Effect.flip(Signer.fromMnemonic(typo, { scheme })), { counts })
        expect(error).toBeInstanceOf(KeyError)
        expect(error.reason).toBe("invalidMnemonic")
        expect(counts).toEqual(before)
      },
      5 * MINUTE
    )
  }

  test(
    "2. /keystore: importMnemonic → unlock → Tx.run executes → lock → Tx.run fails locked with nothing sent",
    async () => {
      const counts: Counts = { simulates: 0, executes: 0 }
      const phrase = await Effect.runPromise(Signer.generateMnemonic(24))
      const password = Redacted.make(`pw-${Math.random()}`)
      const timings: Record<string, number> = {}
      const result = await node(
        Effect.gen(function*() {
          const keystore = yield* Keystore
          let start = performance.now()
          const account = yield* keystore.importMnemonic(phrase, password)
          timings["import"] = Math.round(performance.now() - start)
          start = performance.now()
          const signer = yield* keystore.unlock(account.address, password)
          timings["unlock"] = Math.round(performance.now() - start)
          yield* fundAndFold(signer)
          const friend = stranger()
          const executed = yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer })
          yield* signer.lock
          const executesBefore = counts.executes
          const locked = yield* Effect.flip(Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer }))
          const journal = yield* Journal
          const stored = yield* Effect.flatMap(KeyValueStore.KeyValueStore, (store) =>
            store.get(`${DEFAULT_PREFIX}${account.address}`))
          return {
            iterations: JSON.parse(stored ?? "{}").kdf?.iterations,
            account,
            executed,
            locked,
            sentAfterLock: counts.executes - executesBefore,
            unresolved: yield* journal.listUnresolved,
            received: yield* balanceOf(friend)
          }
        }),
        { counts, extra: Keystore.layer().pipe(Layer.provideMerge(KeyValueStore.layerMemory)) }
      )
      console.log(`keystore (600 000 PBKDF2 iterations): import ${timings["import"]} ms, unlock ${timings["unlock"]} ms`)
      expect(result.iterations).toBe(DEFAULT_ITERATIONS)
      expect(result.executed.effects.status.success).toBe(true)
      expect(result.received.addressBalance).toBe(ONE_SUI)
      expect(result.locked).toBeInstanceOf(SigningError)
      expect(result.locked._tag).toBe("SigningError")
      if (result.locked._tag === "SigningError") expect(result.locked.reason).toBe("locked")
      expect(result.sentAfterLock).toBe(0)
      expect(result.unresolved).toEqual([])
      // Real default iterations: unlocking is deliberately slow, but not unusable.
      expect(timings["unlock"]!).toBeGreaterThan(20)
    },
    5 * MINUTE
  )

  test(
    "3. Signer.passkey over a software P-256 authenticator: a validator accepts the passkey signature",
    async () => {
      const prompts = { count: 0 }
      const key = Secp256r1Keypair.generate()
      const { signer, executed, received } = await node(Effect.gen(function*() {
        const signer = yield* Signer.passkey({
          publicKey: key.getPublicKey().toRawBytes(),
          provider: softwareAuthenticator(key, prompts)
        })
        yield* fundAndFold(signer)
        const friend = stranger()
        const executed = yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer })
        return { signer, executed, received: yield* balanceOf(friend) }
      }))
      expect(signer.scheme).toBe("Passkey")
      expect(executed.effects.status.success).toBe(true)
      expect(executed.sender).toBe(signer.address)
      expect(received.addressBalance).toBe(ONE_SUI)
      // One prompt for the fold, one for the send.
      expect(prompts.count).toBe(2)
    },
    5 * MINUTE
  )

  test(
    "4. Signer.wallet over a keypair-backed Wallet Standard wallet: executes; a wallet that rebuilds different bytes is refused before any send",
    async () => {
      const counts: Counts = { simulates: 0, executes: 0 }
      const key = new Ed25519Keypair()
      const result = await node(Effect.gen(function*() {
        const honest = yield* Signer.wallet({
          wallet: keypairWallet(key, "honest"),
          account: walletAccount(key),
          chain: "sui:localnet"
        })
        yield* fundAndFold(honest)
        const friend = stranger()
        const executed = yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer: honest })
        const executesBefore = counts.executes
        const dishonest = yield* Signer.wallet({
          wallet: keypairWallet(key, "rebuild-differently"),
          account: walletAccount(key),
          chain: "sui:localnet"
        })
        const refused = yield* Effect.flip(
          Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer: dishonest })
        )
        return {
          honest,
          executed,
          refused,
          sentByDishonest: counts.executes - executesBefore,
          received: yield* balanceOf(friend)
        }
      }), { counts })
      expect(result.honest.address).toBe(SuiAddress.make(normalizeSuiAddress(key.toSuiAddress())))
      expect(result.executed.effects.status.success).toBe(true)
      expect(result.received.addressBalance).toBe(ONE_SUI)
      expect(result.refused._tag).toBe("SigningError")
      expect(String((result.refused as SigningError).cause)).toContain("different bytes")
      expect(result.sentByDishonest).toBe(0)
    },
    5 * MINUTE
  )

  test(
    "5a. sponsored, miso-style: a sender with no SUI, a sponsor backend's bytes → verifySponsored → prepare → approve → sign → attach → submit",
    async () => {
      const sponsorKey = new Ed25519Keypair()
      const sponsor = fromKeypair(sponsorKey)
      const phrase = await Effect.runPromise(Signer.generateMnemonic())
      const approvals: Array<Prepared> = []
      const result = await node(Effect.gen(function*() {
        yield* fundAndFold(sponsor)
        const sender = yield* Signer.fromMnemonic(phrase)
        const senderBefore = yield* balanceOf(sender.address)
        const sponsorBefore = yield* balanceOf(sponsor.address)
        const kind = yield* Effect.promise(() => kindOf(recordId(sender.address)))
        const reply = yield* Effect.promise(() => sponsorBackend(sponsorKey, kind, sender.address))
        const built = yield* verifySponsored(yield* Tx.fromBytes(reply.bytes), {
          sender: sender.address,
          gasOwner: sponsor.address,
          transactionKind: kind
        })
        const prepared = yield* Tx.prepare(built, {
          sender: sender.address,
          intent: noClaims("Record my account's object id; the sponsor pays the gas.")
        })
        yield* Effect.sync(() => approvals.push(prepared))
        const signed = yield* Tx.sign(prepared.verified ?? prepared.built, sender)
        const both = yield* Tx.attach(signed, reply.signature)
        const executed = yield* Tx.submit(both)
        return {
          prepared,
          both,
          executed,
          entry: yield* Tx.recorded(both.digest),
          senderBefore,
          senderAfter: yield* balanceOf(sender.address),
          sponsorBefore,
          sponsorAfter: yield* balanceOf(sponsor.address)
        }
      }))
      expect(result.senderBefore).toEqual({ coinBalance: 0n, addressBalance: 0n })
      expect(result.prepared.built.gasOwner).toBe(sponsor.address)
      expect(result.prepared.built.gas.owner).toBe(sponsor.address)
      expect(result.prepared.verified).toBeDefined()
      expect(approvals).toHaveLength(1)
      expect(result.both.signatures).toHaveLength(2)
      expect(result.executed.effects.status.success).toBe(true)
      expect(Option.isSome(result.entry) && result.entry.value._tag).toBe("Executed")
      expect(result.senderAfter).toEqual({ coinBalance: 0n, addressBalance: 0n })
      const gasPaid = result.sponsorBefore.addressBalance - result.sponsorAfter.addressBalance
      expect(gasPaid).toBeGreaterThan(0n)
      console.log(`5a: sponsor paid ${gasPaid} MIST from its address balance; sender stayed at 0`)
    },
    5 * MINUTE
  )

  test(
    "5b. sponsored through Tx.run: gasOwner + Signer.remote sponsor + approve",
    async () => {
      const sponsorKey = new Ed25519Keypair()
      const sponsor = fromKeypair(sponsorKey)
      const phrase = await Effect.runPromise(Signer.generateMnemonic())
      const sponsorSigns = { count: 0 }
      const approvals: Array<Prepared> = []
      const result = await node(Effect.gen(function*() {
        yield* fundAndFold(sponsor)
        const sender = yield* Signer.fromMnemonic(phrase)
        const remote = Signer.remote({
          address: sponsor.address,
          scheme: "ED25519",
          // The sponsor backend, reached over the network in production.
          signTransaction: (bytes) =>
            Effect.promise(async () => {
              sponsorSigns.count += 1
              return (await sponsorKey.signTransaction(bytes)).signature
            })
        })
        let payment = -1
        const executed = yield* Tx.run(recordId(sender.address), {
          signer: sender,
          gasOwner: sponsor.address,
          sponsor: remote,
          approve: (prepared) => Effect.sync(() => approvals.push(prepared)),
          onSigned: (signed) => Effect.sync(() => {
            payment = gasPaymentOf(signed.bytes)
          })
        })
        return { executed, sender, payment, senderAfter: yield* balanceOf(sender.address) }
      }))
      expect(result.executed.effects.status.success).toBe(true)
      expect(result.payment).toBe(0)
      expect(approvals).toHaveLength(1)
      expect(approvals[0]!.built.gasOwner).toBe(sponsor.address)
      expect(approvals[0]!.built.sender).toBe(result.sender.address)
      expect(sponsorSigns.count).toBe(1)
      expect(result.senderAfter).toEqual({ coinBalance: 0n, addressBalance: 0n })
    },
    5 * MINUTE
  )

  test(
    "5c. tampered sponsor bytes (sender changed, kind changed) are refused with PolicyDenied before signing",
    async () => {
      const sponsorKey = new Ed25519Keypair()
      const phrase = await Effect.runPromise(Signer.generateMnemonic())
      const signs = { count: 0 }
      const counts: Counts = { simulates: 0, executes: 0 }
      const refusals = await node(Effect.gen(function*() {
        yield* fundAndFold(fromKeypair(sponsorKey))
        const sender = countingSigns(yield* Signer.fromMnemonic(phrase), signs)
        const kind = yield* Effect.promise(() => kindOf(recordId(sender.address)))
        const attempt = (tamper: "sender" | "kind") =>
          Effect.gen(function*() {
            const reply = yield* Effect.promise(() => sponsorBackend(sponsorKey, kind, sender.address, tamper))
            const built = yield* verifySponsored(yield* Tx.fromBytes(reply.bytes), {
              sender: sender.address,
              gasOwner: sponsorKey.toSuiAddress(),
              transactionKind: kind
            })
            return yield* Tx.sign(built, sender)
          })
        const before = { ...counts }
        const errors = [yield* Effect.flip(attempt("sender")), yield* Effect.flip(attempt("kind"))]
        return { errors, simulated: counts.simulates - before.simulates, sent: counts.executes - before.executes }
      }), { counts })
      expect(refusals.errors.map((error) => error._tag)).toEqual(["PolicyDenied", "PolicyDenied"])
      expect(refusals.errors.map((error) => (error as PolicyDenied).rule)).toEqual([
        "sponsored.sender",
        "sponsored.kind"
      ])
      expect(signs.count).toBe(0)
      expect(refusals.simulated).toBe(0)
      expect(refusals.sent).toBe(0)
    },
    5 * MINUTE
  )

  test(
    "6. a dapp's transaction: fromBytes → prepare → Intent.fromSimulation → verify passes; an extra unclaimed recipient is intent.recipient",
    async () => {
      const key = new Ed25519Keypair()
      const user = fromKeypair(key)
      const friend = stranger()
      const other = stranger()
      const result = await node(Effect.gen(function*() {
        yield* fundAndFold(user)
        // The dapp builds against its own client and hands over bytes.
        const dappBytes = (sends: ReadonlyArray<readonly [SuiAddress, bigint]>) =>
          Effect.promise(async () => {
            const tx = new Transaction()
            tx.setSender(user.address)
            for (const [recipient, amount] of sends) Tx.sendFunds({ amount, recipient })(tx)
            return Transaction.from(await tx.toJSON({ client: grpc })).build({ client: grpc })
          })
        const bytes = yield* dappBytes([[friend, ONE_SUI]])
        const prepared = yield* Tx.prepare(yield* Tx.fromBytes(bytes), { sender: user.address })
        const intent = Intent.fromSimulation(prepared.simulation, prepared.built, {
          summary: "Send 1 SUI to a friend.",
          author: "dapp"
        })
        const verified = yield* Tx.verify(prepared.built, intent)
        // Same total, half of it to an address the intent never named.
        const variant = yield* Tx.fromBytes(yield* dappBytes([[friend, ONE_SUI / 2n], [other, ONE_SUI / 2n]]))
        const refused = yield* Effect.flip(Tx.verify(variant, intent))
        const executed = yield* Tx.submit(yield* Tx.sign(verified, user))
        return { bytes, intent, verified, refused, executed, received: yield* balanceOf(friend) }
      }))
      expect(gasPaymentOf(result.bytes)).toBe(0)
      expect(result.intent.claims.recipients).toEqual([friend])
      expect(result.intent.claims.outflows).toEqual([{ coinType: CoinType.SUI, max: ONE_SUI }])
      expect(result.verified.verdict._tag).toBe("Unscreened")
      expect(result.refused._tag).toBe("PolicyDenied")
      expect((result.refused as PolicyDenied).rule).toBe("intent.recipient")
      expect(result.executed.effects.status.success).toBe(true)
      expect(result.received.addressBalance).toBe(ONE_SUI)
    },
    5 * MINUTE
  )

  test(
    "7. the durable journal over the IndexedDB stand-in: settled across a fresh layer, and a crashed Signed entry reconciles to Executed",
    async () => {
      const idb = makeFakeIndexedDb()
      const journalOver = (onUnresolved: "fail" | "ignore" = "ignore") =>
        layerKeyValueStore({ onUnresolved }).pipe(Layer.provide(layerIndexedDb({ indexedDB: idb.factory })))
      const signer = fromKeypair(new Ed25519Keypair())
      const friend = stranger()

      // Run 1: an ordinary run, journalled durably.
      const first = await node(Effect.gen(function*() {
        yield* fundAndFold(signer)
        return yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { signer })
      }), { journal: journalOver() })
      expect(first.effects.status.success).toBe(true)

      // Run 2: a fresh journal over the same store sees it settled; nothing is unresolved.
      const reopened = await node(Effect.gen(function*() {
        return { entry: yield* Tx.recorded(first.digest), reconciled: yield* Tx.reconcileAll() }
      }), { journal: journalOver("fail") })
      expect(Option.isSome(reopened.entry) && reopened.entry.value._tag).toBe("Executed")
      expect(reopened.reconciled).toEqual([])

      // Run 3: sign, journal `Signed`, send outside the library, and "crash" before recording.
      const crashed: Signed = await node(Effect.gen(function*() {
        const built = yield* Tx.build(Tx.sendFunds({ amount: ONE_SUI, recipient: friend }), { sender: signer.address })
        const signed = yield* Tx.sign(built, signer)
        yield* (yield* Journal).put(JournalEntry.cases.Signed.make({
          _tag: "Signed",
          digest: signed.digest,
          signed,
          signedAt: yield* DateTime.now
        }))
        yield* Effect.promise(async () => {
          const sent = await grpc.core.executeTransaction({ transaction: signed.bytes, signatures: [...signed.signatures] })
          if (sent.$kind !== "Transaction") throw new Error(`the raw send failed: ${sent.$kind}`)
          await visible(signed.digest)
        })
        return signed
      }), { journal: journalOver() })

      // A strict startup refuses the store while the entry is unresolved.
      const strict = await node(Effect.flip(Tx.recorded(crashed.digest)), { journal: journalOver("fail") })
        .then(() => "built", (error: unknown) => (error as { _tag?: string })._tag)
      expect(strict).toBe("JournalError")

      // Run 4: a fresh process reconciles it from the chain.
      const recovered = await node(Effect.gen(function*() {
        const before = yield* Tx.recorded(crashed.digest)
        const reconciled = yield* Tx.reconcileAll()
        return { before, reconciled, after: yield* Tx.recorded(crashed.digest) }
      }), { journal: journalOver() })
      expect(Option.isSome(recovered.before) && recovered.before.value._tag).toBe("Signed")
      expect(recovered.reconciled.map((each) => each._tag)).toEqual(["Executed"])
      const settled = recovered.reconciled[0]!
      if (settled._tag === "Executed") expect(settled.executed.digest).toBe(crashed.digest)
      expect(Option.isSome(recovered.after) && recovered.after.value._tag).toBe("Executed")

      // And a strict startup now builds.
      const finally_ = await node(Tx.reconcileAll(), { journal: journalOver("fail") })
      expect(finally_).toEqual([])
      console.log(`7: IndexedDB stand-in served ${JSON.stringify(idb.calls)}`)
    },
    5 * MINUTE
  )

  test(
    "8. zkLogin session bound: maxEpoch = current epoch builds bytes the node simulates (window capped); below it is expired before building",
    async () => {
      const funder = fromKeypair(new Ed25519Keypair())
      const counts: Counts = { simulates: 0, executes: 0 }
      let attempts = 0
      const result = await node(Effect.gen(function*() {
        yield* fundAndFold(funder)
        // Up to three tries: an epoch can roll over between reading it and building.
        const attempt = Effect.gen(function*() {
          attempts += 1
          const epoch = yield* currentEpoch
          const session = zkSession(epoch, BigInt(Math.floor(Math.random() * 1e9)))
          const signer = yield* Signer.zkLogin({ session, ephemeral: new Ed25519Keypair() })
          // The zkLogin address pays from an address balance it is sent.
          yield* Tx.run(Tx.sendFunds({ amount: ONE_SUI, recipient: signer.address }), { signer: funder })
          let captured: Signed | undefined
          const stopped = yield* Effect.flip(Tx.run(Tx.sendFunds({ amount: ONE_SUI / 10n, recipient: stranger() }), {
            signer,
            onSigned: (signed) =>
              Effect.suspend(() => {
                captured = signed
                return Effect.fail(new JournalError({ cause: "stop before the send: the proof is a placeholder" }))
              })
          }))
          return { epoch, signer, stopped, captured }
        })
        const capped = yield* Effect.retry(
          Effect.filterOrFail(attempt, (value) => value.captured !== undefined, (value) => value.stopped),
          { times: 2 }
        )
        const executesBefore = counts.executes
        const simulation = yield* (yield* Sui).simulate(capped.captured!.bytes)
        // A session that ended before the current epoch.
        const expiredSigner = yield* Signer.zkLogin({
          session: zkSession(capped.epoch - 1n, 7n),
          ephemeral: new Ed25519Keypair()
        })
        const simulatesBefore = counts.simulates
        const expired = yield* Effect.flip(
          Tx.run(Tx.sendFunds({ amount: 1n, recipient: stranger() }), { signer: expiredSigner })
        )
        return {
          ...capped,
          simulation,
          expired,
          expiredSimulates: counts.simulates - simulatesBefore,
          sent: counts.executes - executesBefore
        }
      }), { counts })
      console.log(`8: capped at epoch ${result.epoch} after ${attempts} attempt(s)`)
      expect(result.signer.scheme).toBe("ZkLogin")
      expect(result.stopped._tag).toBe("JournalError")
      const expiration = result.captured!.expiration
      expect(expiration).toBeDefined()
      const window = (expiration as { ValidDuring?: { minEpoch?: string; maxEpoch?: string } }).ValidDuring
      expect(BigInt(window!.maxEpoch!)).toBe(result.epoch)
      expect(result.simulation.effects.status.success).toBe(true)
      expect(result.expired._tag).toBe("SigningError")
      if (result.expired._tag === "SigningError") expect(result.expired.reason).toBe("expired")
      expect(result.expiredSimulates).toBe(0)
      expect(result.sent).toBe(0)
    },
    5 * MINUTE
  )
})
