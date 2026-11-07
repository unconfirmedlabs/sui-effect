/**
 * 0.6.0 address aliases and multisig signers, on the fake: `AddressAlias`
 * (the derived object, the read, the check, the recipes), `Signer.multisig`
 * (member order, any member scheme, the construction checks), `Signer.alias`
 * ("sender A, signed by M"), and what `Tx.run`, `Tx.attach`, `Tx.sign` and
 * `Verify` do with them — the sender lock and the journal keyed on A, a key
 * outside the set refused before anything is built, and the fake refusing a
 * signature its alias sets do not cover, the way a validator does.
 */
import { describe, expect, test } from "bun:test"
import type { PublicKey } from "@mysten/sui/cryptography"
import { parseSerializedSignature } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { PasskeyKeypair, type PasskeyProvider, PasskeyPublicKey } from "@mysten/sui/keypairs/passkey"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { deriveObjectID, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { computeZkLoginAddressFromSeed, genAddressSeed, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin"
import { Deferred, Effect, Fiber, Option } from "effect"
import { SuiAddress } from "../src/domain/schemas.ts"
import { AddressAlias } from "../src/services/AddressAlias.ts"
import type { JournalEntry } from "../src/domain/journal-entry.ts"
import { Journal, type JournalService } from "../src/services/Journal.ts"
import { fromKeypair, Signer } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { Verify } from "../src/services/Verify.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = "0x2::sui::SUI"
const ONE_SUI = 1_000_000_000n

const key = (fill: number) => Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(fill))

// The account A, its original key, and the multisig M of three members that
// becomes A's only alias.
const accountKey = key(61)
const account = fromKeypair(accountKey)
const A = account.address
const passkeyLike = key(62)
const phrase = key(63)
const watchdog = key(64)
const members = [passkeyLike, phrase, watchdog]
const M_KEY = MultiSigPublicKey.fromPublicKeys({
  threshold: 2,
  publicKeys: members.map((member) => ({ publicKey: member.getPublicKey(), weight: 1 }))
})
const M = SuiAddress.make(normalizeSuiAddress(M_KEY.toSuiAddress()))
const stranger = fromKeypair(key(65))
const sponsorKey = key(66)
const sponsor = fromKeypair(sponsorKey)

const funded = (who: string, amount = ONE_SUI) => ({
  owner: who,
  coinType: SUI,
  balance: amount.toString(),
  coinBalance: "0",
  addressBalance: amount.toString()
})

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  balances: [funded(A), funded(sponsor.address)],
  execute: Array.from({ length: 8 }, () => FakeOutcome.succeed())
}

const run = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake>, script: FakeScript = baseScript) =>
  effect.pipe(SuiTest.provide(layerTest(script)), Effect.runPromise)

const ping = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
}

/** M signing with two of its three members, given out of member order on purpose. */
const multisig = Signer.multisig(M_KEY, [fromKeypair(watchdog), fromKeypair(passkeyLike)])

/** Full transaction bytes with sender `sender`, built without a client. */
const bytesFor = async (sender: string, gasOwner?: string) => {
  const tx = new Transaction()
  tx.setSender(sender)
  if (gasOwner !== undefined) tx.setGasOwner(gasOwner)
  tx.setGasPayment([])
  tx.setGasBudget(1_000_000)
  tx.setGasPrice(1_000)
  tx.setExpiration({
    ValidDuring: { minEpoch: "100", maxEpoch: "101", minTimestamp: null, maxTimestamp: null, chain: CHAIN_ID, nonce: 9 }
  })
  ping(tx)
  return tx.build()
}

const addressOf = (publicKey: PublicKey) => normalizeSuiAddress(publicKey.toSuiAddress())

describe("AddressAlias: the object, the read and the check", () => {
  test("aliasesId is the object derived from 0xa at AliasKey(address)", () => {
    const expected = deriveObjectID(
      PADDED("a"),
      "0x0000000000000000000000000000000000000000000000000000000000000002::address_alias::AliasKey",
      Uint8Array.from(Buffer.from(A.slice(2), "hex"))
    )
    expect<string>(AddressAlias.aliasesId(A)).toBe(normalizeSuiAddress(expected))
    // Spelling does not matter: the key is the padded address.
    expect(AddressAlias.aliasesId("0x2")).toBe(AddressAlias.aliasesId(PADDED("2")))
    expect(AddressAlias.aliasesId(A)).not.toBe(AddressAlias.aliasesId(M))
  })

  test("getAliases: NotEnabled without the object, Enabled with its set after", async () => {
    const [before, after] = await run(Effect.gen(function*() {
      const before = yield* AddressAlias.getAliases(A)
      yield* SuiTest.setAddressAliases(A, [M])
      return [before, yield* AddressAlias.getAliases(A)] as const
    }))
    expect(before).toEqual({ _tag: "NotEnabled", address: A })
    expect(after._tag).toBe("Enabled")
    if (after._tag !== "Enabled") return
    expect(after.aliases).toEqual([M])
    expect(after.id).toBe(AddressAlias.aliasesId(A))
  })

  test("allows: the address itself until enabled, then exactly the set", () => {
    const notEnabled = { _tag: "NotEnabled", address: A } as const
    const enabled = { _tag: "Enabled", address: A, id: AddressAlias.aliasesId(A), version: "2", aliases: [M] } as never
    expect(AddressAlias.allows(notEnabled, A)).toBe(true)
    expect(AddressAlias.allows(notEnabled, M)).toBe(false)
    expect(AddressAlias.allows(enabled, M)).toBe(true)
    // Removed from its own set: its own key no longer signs for it.
    expect(AddressAlias.allows(enabled, A)).toBe(false)
  })

  test("requireSigner: a key outside the set is PolicyDenied { alias.signer }, never a silent pass", async () => {
    const [notEnabled, outside, removedSelf, member] = await run(Effect.gen(function*() {
      const notEnabled = yield* Effect.flip(AddressAlias.requireSigner(A, M))
      yield* SuiTest.setAddressAliases(A, [M])
      const outside = yield* Effect.flip(AddressAlias.requireSigner(A, stranger.address))
      const removedSelf = yield* Effect.flip(AddressAlias.requireSigner(A, A))
      return [notEnabled, outside, removedSelf, yield* AddressAlias.requireSigner(A, M)] as const
    }))
    for (const error of [notEnabled, outside, removedSelf]) {
      expect(error._tag).toBe("PolicyDenied")
      if (error._tag === "PolicyDenied") expect(error.rule).toBe("alias.signer")
    }
    expect(notEnabled.message).toContain("has not enabled address aliases")
    expect(member._tag).toBe("Enabled")
  })

  test("a read the node cannot serve is a TransportError, neither accepted nor refused", async () => {
    const error = await run(
      Effect.flip(AddressAlias.requireSigner(A, M)),
      // Non-retryable, so no read retry waits on the test clock.
      { ...baseScript, getObject: [FakeOutcome.transportError("PERMISSION_DENIED")] }
    )
    expect(error._tag).toBe("TransportError")
  })

  test("the recipes call 0x2::address_alias's entry functions, each its own command", async () => {
    const tx = new Transaction()
    AddressAlias.enable()(tx)
    AddressAlias.add({ address: A, alias: M })(tx)
    AddressAlias.remove({ address: A, alias: A })(tx)
    AddressAlias.replaceAll({ address: A, aliases: [M, M] })(tx)
    const calls = tx.getData().commands.map((command) => command.MoveCall?.function)
    expect(calls).toEqual(["enable", "add", "remove", "replace_all"])
    expect(tx.getData().commands.every((command) => command.MoveCall?.module === "address_alias")).toBe(true)
  })
})

describe("Signer.multisig", () => {
  test("combines in member order: a signature the SDK's own order-keeping combine gets wrong verifies", async () => {
    const bytes = await bytesFor(M)
    const [signature, publicKey, wrongOrder] = await run(Effect.gen(function*() {
      const signer = yield* multisig
      expect(signer.address).toBe(M)
      expect(signer.scheme).toBe("MultiSig")
      const signature = yield* signer.signTransaction(bytes)
      const publicKey = yield* Verify.verifyTransactionSignature(bytes, signature, { address: M })
      // The same two partial signatures in the order they were given
      // (watchdog = member 2, then passkey = member 0): the bitmap is right,
      // the pairing is not.
      const partial = [(yield* Effect.promise(() => watchdog.signTransaction(bytes))).signature, (yield* Effect.promise(() => passkeyLike.signTransaction(bytes))).signature]
      const wrongOrder = yield* Effect.flip(Verify.verifyTransactionSignature(bytes, M_KEY.combinePartialSignatures(partial), { address: M }))
      return [signature, publicKey, wrongOrder] as const
    }))
    expect(addressOf(publicKey)).toBe(M)
    const parsed = parseSerializedSignature(signature)
    if (parsed.signatureScheme !== "MultiSig") throw new Error("not a multisig")
    expect(parsed.multisig.bitmap).toBe(0b101)
    expect(wrongOrder._tag).toBe("SigningError")
  })

  test("refuses a non-member, a duplicate member and too little weight, as KeyError { invalidMultisig }", async () => {
    const errors = await run(Effect.all([
      Effect.flip(Signer.multisig(M_KEY, [fromKeypair(passkeyLike), stranger])),
      Effect.flip(Signer.multisig(M_KEY, [fromKeypair(passkeyLike), fromKeypair(passkeyLike)])),
      Effect.flip(Signer.multisig(M_KEY, [fromKeypair(phrase)]))
    ]))
    for (const error of errors) {
      expect(error._tag).toBe("KeyError")
      expect(error.reason).toBe("invalidMultisig")
      expect(error.outcome).toBe("not_applied")
    }
    expect(errors[0].message).toContain(stranger.address)
    expect(errors[2].message).toContain("threshold is 2")
  })

  test("signs a personal message the SDK verifies as the multisig", async () => {
    const message = new TextEncoder().encode("sign in to miso")
    const publicKey = await run(Effect.gen(function*() {
      const signer = yield* multisig
      return yield* Verify.verifyPersonalMessageSignature(message, yield* signer.signPersonalMessage(message), { address: M })
    }))
    expect(addressOf(publicKey)).toBe(M)
  })

  test("a passkey member (the SDK's PasskeyKeypair): the WebAuthn partial signature lands on its bit and verifies", async () => {
    const bytes = await bytesFor(PADDED("1"))
    const result = await run(Effect.gen(function*() {
      const passkey = Signer.fromSdkSigner(new PasskeyKeypair(PASSKEY_PUBLIC_KEY, stubProvider()))
      const publicKey = MultiSigPublicKey.fromPublicKeys({
        threshold: 2,
        publicKeys: [
          { publicKey: phrase.getPublicKey(), weight: 1 },
          { publicKey: new PasskeyPublicKey(PASSKEY_PUBLIC_KEY), weight: 1 }
        ]
      })
      // Given passkey first; it is member 1.
      const signer = yield* Signer.multisig(publicKey, [passkey, fromKeypair(phrase)])
      const signature = yield* signer.signTransaction(bytes)
      const verified = yield* Verify.verifyTransactionSignature(bytes, signature, { address: signer.address })
      return { signature, verified, address: signer.address }
    }))
    expect(addressOf(result.verified)).toBe(result.address)
    const parsed = parseSerializedSignature(result.signature)
    if (parsed.signatureScheme !== "MultiSig") throw new Error("not a multisig")
    expect(parsed.multisig.sigs.map((sig) => Object.keys(sig).filter((name) => name !== "$kind")[0])).toEqual(["ED25519", "Passkey"])
  })

  test("a zkLogin member: its signature goes on its bit, and its maxEpoch bounds the multisig's", async () => {
    const zkPublicKey = toZkLoginPublicIdentifier(BigInt(ADDRESS_SEED), ISS, { legacyAddress: false })
    const publicKey = MultiSigPublicKey.fromPublicKeys({
      threshold: 2,
      publicKeys: [
        { publicKey: zkPublicKey, weight: 1 },
        { publicKey: phrase.getPublicKey(), weight: 1 }
      ]
    })
    expect(normalizeSuiAddress(zkPublicKey.toSuiAddress())).toBe(ZK_ADDRESS)
    const bytes = await bytesFor(publicKey.toSuiAddress())
    const { signature, maxEpoch } = await Effect.runPromise(
      Effect.gen(function*() {
        const zk = yield* Signer.zkLogin({ address: ZK_ADDRESS, inputs: proof, maxEpoch: MAX_EPOCH, ephemeralSigner: ephemeral })
        // Given the phrase first; the zkLogin identifier is member 0.
        const signer = yield* Signer.multisig(publicKey, [fromKeypair(phrase), zk])
        return { signature: yield* signer.signTransaction(bytes), maxEpoch: signer.maxEpoch }
      })
    )
    expect(maxEpoch).toBe(MAX_EPOCH)
    const parsed = parseSerializedSignature(signature)
    if (parsed.signatureScheme !== "MultiSig") throw new Error("not a multisig")
    expect(parsed.multisig.bitmap).toBe(0b11)
    expect(parsed.multisig.sigs.map((sig) => Object.keys(sig).filter((name) => name !== "$kind")[0])).toEqual(["ZkLogin", "ED25519"])
  })

})

describe("Signer.alias", () => {
  test("signs as the account with the alias's key; personal messages are refused", async () => {
    const result = await run(Effect.gen(function*() {
      const m = yield* multisig
      const aliased = Signer.alias(A, m)
      const refused = yield* Effect.flip(aliased.signPersonalMessage(new Uint8Array([1])))
      return { aliased, refused }
    }))
    expect(result.aliased.address).toBe(A)
    expect(result.aliased.alias).toBe(M)
    expect(result.aliased.scheme).toBe("MultiSig")
    expect(result.refused.reason).toBe("unavailable")
    // An address is its own alias: nothing to wrap.
    expect(Signer.alias(A, account)).toBe(account)
  })

  test("Tx.sign compares the account, offline: an alias signer signs A's bytes, M's own signer does not", async () => {
    const [signed, refused, reads] = await run(Effect.gen(function*() {
      const built = yield* Tx.fromBytes(yield* Effect.promise(() => bytesFor(A)))
      const m = yield* multisig
      const signed = yield* Tx.sign(built, Signer.alias(A, m))
      const refused = yield* Effect.flip(Tx.sign(built, m))
      return [signed, refused, (yield* SuiTest.calls("getObject")).length] as const
    }))
    expect(signed.sender).toBe(A)
    expect(parseSerializedSignature(signed.signatures[0]!).signatureScheme).toBe("MultiSig")
    expect(refused._tag).toBe("SigningError")
    expect(reads).toBe(0)
  })
})

describe("Tx.run: sender A, signed by M", () => {
  const aliased: FakeScript = { ...baseScript, addressAliases: { [A]: [M] } }

  test("runs with A as the sender and M's signature; the journal records A", async () => {
    const result = await run(Effect.gen(function*() {
      const signer = Signer.alias(A, yield* multisig)
      let signedSender = ""
      const executed = yield* Tx.run(ping, {
        signer,
        onSigned: (signed) => Effect.sync(() => void (signedSender = signed.sender))
      })
      const entry = yield* (yield* Journal).get(executed.digest)
      const sent = yield* SuiTest.calls("executeTransaction")
      return { executed, entry, sent, signedSender }
    }), aliased)
    const options = result.sent[0]!.options as { transaction: Uint8Array; signatures: Array<string> }
    expect(TransactionDataBuilder.fromBytes(options.transaction).sender).toBe(A)
    expect(options.signatures).toHaveLength(1)
    expect(parseSerializedSignature(options.signatures[0]!).signatureScheme).toBe("MultiSig")
    expect(result.signedSender).toBe(A)
    expect(Option.isSome(result.entry) && result.entry.value._tag).toBe("Executed")
  })

  test("the journal's Signed entry names A as the sender", async () => {
    const puts = await run(Effect.gen(function*() {
      const memory = yield* Journal
      const seen: Array<JournalEntry> = []
      const recording: JournalService = { ...memory, put: (entry) => Effect.andThen(Effect.sync(() => void seen.push(entry)), memory.put(entry)) }
      yield* Tx.run(ping, { signer: Signer.alias(A, yield* multisig) }).pipe(Effect.provideService(Journal, recording))
      return seen
    }), aliased)
    const signed = puts.find((entry) => entry._tag === "Signed")
    expect(signed?._tag === "Signed" && signed.signed.sender).toBe(A)
    expect(puts.map((entry) => entry._tag)).toEqual(["Signed", "Executed"])
  })

  test("the sender lock is A's, not M's", async () => {
    const order = await run(Effect.gen(function*() {
      const inApprove = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const events: Array<string> = []
      const signer = Signer.alias(A, yield* multisig)
      const fiber = yield* Effect.forkChild(
        Tx.run(ping, {
          signer,
          approve: () => Deferred.succeed(inApprove, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }).pipe(SubmitConfig.with({ lockSender: "always" }))
      )
      yield* Deferred.await(inApprove)
      // M's lock is free while A's run is approving under A's lock.
      yield* Tx.withSenderLock(M)(Effect.sync(() => events.push("M")))
      const waiting = yield* Effect.forkChild(Tx.withSenderLock(A)(Effect.sync(() => events.push("A"))))
      yield* Effect.yieldNow
      events.push("release")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      yield* Fiber.join(waiting)
      return events
    }), { ...aliased, simulate: [FakeOutcome.succeed()] })
    expect(order).toEqual(["M", "release", "A"])
  })

  test("a key A does not list is PolicyDenied { alias.signer } before anything is built", async () => {
    const [error, simulates, executes] = await run(Effect.gen(function*() {
      const outsider = yield* Signer.multisig(M_KEY, [fromKeypair(passkeyLike), fromKeypair(phrase)])
      const error = yield* Effect.flip(Tx.run(ping, { signer: Signer.alias(A, Signer.alias(A, stranger)) }))
      expect((yield* Effect.flip(Tx.run(ping, { signer: Signer.alias(A, outsider) })))._tag).toBe("PolicyDenied")
      return [
        error,
        (yield* SuiTest.calls("simulateTransaction")).length,
        (yield* SuiTest.calls("executeTransaction")).length
      ] as const
    }), { ...baseScript, addressAliases: { [A]: [A] } })
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag === "PolicyDenied") expect(error.rule).toBe("alias.signer")
    expect(simulates).toBe(0)
    expect(executes).toBe(0)
  })

  test("a sponsor signing as its gas owner through an alias co-signs", async () => {
    const sponsorAlias = fromKeypair(key(67))
    const executed = await run(
      Tx.run(Tx.sponsored({ sender: A, gasOwner: sponsor.address })(ping), {
        signer: account,
        sponsor: Signer.alias(sponsor.address, sponsorAlias)
      }),
      { ...baseScript, addressAliases: { [sponsor.address]: [sponsorAlias.address] } }
    )
    expect(executed.digest.length).toBeGreaterThan(0)
  })

  test("the whole story on the fake: enable, add M, remove A, run as M, the old key refused", async () => {
    const story = await run(Effect.gen(function*() {
      yield* Tx.run(AddressAlias.enable(), { signer: account })
      const enabled = yield* SuiTest.addressAliases(A)
      yield* Tx.run((tx) => {
        AddressAlias.add({ address: A, alias: M })(tx)
        AddressAlias.remove({ address: A, alias: A })(tx)
      }, { signer: account })
      const aliases = yield* AddressAlias.getAliases(A)
      const executed = yield* Tx.run(ping, { signer: Signer.alias(A, yield* multisig) })
      const old = yield* Effect.flip(Tx.run(ping, { signer: account }))
      const oldEntry = yield* Effect.flatMap(SuiTest.calls("executeTransaction"), (calls) => {
        const last = calls[calls.length - 1]!.options as { transaction: Uint8Array }
        return Effect.flatMap(Effect.service(Journal), (journal) => journal.get(TransactionDataBuilder.getDigestFromBytes(last.transaction) as never))
      })
      return { enabled, aliases, executed, old, oldEntry }
    }))
    expect(story.enabled).toEqual(Option.some([A]))
    expect(story.aliases._tag === "Enabled" && story.aliases.aliases).toEqual([M])
    expect(story.executed.digest.length).toBeGreaterThan(0)
    // The node refuses the old key outright; nothing executed, settled refused.
    expect(story.old._tag).toBe("TransportError")
    if (story.old._tag === "TransportError") expect(story.old.status).toBe("INVALID_ARGUMENT")
    expect(Option.isSome(story.oldEntry) && story.oldEntry.value._tag).toBe("NotApplied")
  })

  test("the fake refuses M's signature for an A that never listed it, as a validator does", async () => {
    const error = await run(Effect.gen(function*() {
      const built = yield* Tx.fromBytes(yield* Effect.promise(() => bytesFor(A)))
      const signed = yield* Tx.sign(built, Signer.alias(A, yield* multisig))
      return yield* Effect.flip(Tx.submit(signed))
    }))
    expect(error._tag).toBe("TransportError")
  })
})

describe("Tx.attach and Verify against the alias set", () => {
  test("Tx.attach accepts M's signature on A's bytes when A lists M, and refuses it otherwise", async () => {
    const bytes = await bytesFor(A)
    const signature = await run(Effect.flatMap(multisig, (m) => m.signTransaction(bytes)))
    const listed = await run(Effect.gen(function*() {
      const built = yield* Tx.fromBytes(bytes)
      return yield* Tx.attach(built, signature)
    }), { ...baseScript, addressAliases: { [A]: [M] } })
    expect(listed.sender).toBe(A)
    expect(listed.signatures).toEqual([signature] as never)
    const refused = await run(Effect.gen(function*() {
      return yield* Effect.flip(Tx.attach(yield* Tx.fromBytes(bytes), signature))
    }))
    expect(refused._tag).toBe("PolicyDenied")
    if (refused._tag === "PolicyDenied") {
      expect(refused.rule).toBe("alias.signer")
      expect(refused.message).toContain("has not enabled address aliases")
    }
  })

  test("Tx.attach reads nothing for a signature by the sender itself", async () => {
    const bytes = await bytesFor(A)
    const reads = await run(Effect.gen(function*() {
      yield* Tx.attach(yield* Tx.fromBytes(bytes), (yield* account.signTransaction(bytes)))
      return (yield* SuiTest.calls("getObject")).length
    }))
    expect(reads).toBe(0)
  })

  test("Verify with checkAddressAliases: the alias passes, a removed own key and a stranger are refused", async () => {
    const bytes = await bytesFor(A)
    const result = await run(Effect.gen(function*() {
      const ownBefore = yield* Verify.verifyTransactionSignature(bytes, yield* account.signTransaction(bytes), {
        address: A,
        checkAddressAliases: true
      })
      yield* SuiTest.setAddressAliases(A, [M])
      const viaM = yield* Verify.verifyTransactionSignature(bytes, yield* (yield* multisig).signTransaction(bytes), {
        address: A,
        checkAddressAliases: true
      })
      const own = yield* Effect.flip(Verify.verifyTransactionSignature(bytes, yield* account.signTransaction(bytes), {
        address: A,
        checkAddressAliases: true
      }))
      const strange = yield* Effect.flip(Verify.verifyTransactionSignature(bytes, yield* stranger.signTransaction(bytes), {
        address: A,
        checkAddressAliases: true
      }))
      // Without the option, the strict "made by this address" check, unchanged.
      const strict = yield* Effect.flip(Verify.verifyTransactionSignature(bytes, yield* (yield* multisig).signTransaction(bytes), {
        address: A
      }))
      return { ownBefore, viaM, own, strange, strict }
    }))
    expect(addressOf(result.ownBefore)).toBe(A)
    expect(addressOf(result.viaM)).toBe(M)
    expect(result.own._tag).toBe("PolicyDenied")
    expect(result.strange._tag).toBe("PolicyDenied")
    expect(result.strict._tag).toBe("SigningError")
  })
})

// ---------------------------------------------------------------------------
// Fixtures for the passkey and zkLogin members.
// ---------------------------------------------------------------------------

const ISS = "https://accounts.google.com"
const base64Url = (text: string) =>
  toBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const ADDRESS_SEED = genAddressSeed(BigInt(1234), "sub", "user-1", "client-1").toString()
const proof = {
  proofPoints: { a: ["1", "2", "1"], b: [["1", "0"], ["1", "0"], ["1", "0"]], c: ["1", "2", "1"] },
  issBase64Details: { value: base64Url(`"iss":"${ISS}",`), indexMod4: 0 },
  headerBase64: base64Url("{\"alg\":\"RS256\"}"),
  addressSeed: ADDRESS_SEED
}
const ZK_ADDRESS = SuiAddress.make(computeZkLoginAddressFromSeed(BigInt(ADDRESS_SEED), ISS, false))
const ephemeral = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
const MAX_EPOCH = 101n

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

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer
const authenticator = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(5))
const PASSKEY_PUBLIC_KEY = authenticator.getPublicKey().toRawBytes()

const stubProvider = (): PasskeyProvider => ({
  create: () => Promise.reject(new Error("not used")),
  get: async (challenge: Uint8Array) => {
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: "webauthn.get",
      challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      origin: "https://miso.test"
    }))
    const authenticatorData = new Uint8Array(37).fill(1)
    const payload = Uint8Array.from([...authenticatorData, ...(await sha256(clientDataJSON))])
    return {
      response: {
        authenticatorData: buffer(authenticatorData),
        clientDataJSON: buffer(clientDataJSON),
        signature: buffer(derOf(await authenticator.sign(payload)))
      }
    } as unknown as Awaited<ReturnType<PasskeyProvider["get"]>>
  }
})
