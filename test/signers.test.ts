/**
 * Signers as values, and verification: keys from a phrase or a secret, the
 * multisig member order validators require, the alias signer, the zkLogin
 * `maxEpoch` bound, `Verify` (locally, through a stubbed node for zkLogin, and
 * against an address's alias set), and the alias helpers.
 */
import { describe, expect, test } from "bun:test"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { decodeSuiPrivateKey, type PublicKey, parseSerializedSignature, Signer as SdkSigner, type SignatureScheme } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { PasskeyKeypair, type PasskeyProvider, PasskeyPublicKey } from "@mysten/sui/keypairs/passkey"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { Transaction } from "@mysten/sui/transactions"
import { deriveObjectID, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { computeZkLoginAddressFromSeed, genAddressSeed, getZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { Config, ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect"
import { ADDRESS_ALIAS_STATE_ID, ADDRESS_ALIASES_TYPE, AddressAliasesBcs, aliasesId, allows } from "../src/domain/address-alias.ts"
import { SigningError, SuiError } from "../src/domain/errors.ts"
import { Signature, SuiAddress } from "../src/domain/schemas.ts"
import { AddressAlias } from "../src/services/AddressAlias.ts"
import { Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"
import { Verify } from "../src/services/Verify.ts"
import { type FakeObject, SuiTest } from "../src/testing.ts"
import { bytes as offline, CHAIN, EPOCH, fail, keypair, run } from "./support.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const message = new TextEncoder().encode("hello")
const runPure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const failPure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))
const addressOf = (publicKey: PublicKey) => normalizeSuiAddress(publicKey.toSuiAddress())

const account = Signer.fromKeypair(keypair(61))
const A = account.address
const members = [keypair(62), keypair(63), keypair(64)]
const M_KEY = MultiSigPublicKey.fromPublicKeys({ threshold: 2, publicKeys: members.map((member) => ({ publicKey: member.getPublicKey(), weight: 1 })) })
const M = SuiAddress.make(normalizeSuiAddress(M_KEY.toSuiAddress()))
const stranger = Signer.fromKeypair(keypair(65))
/** M with two members given out of member order on purpose: member 2, then member 0. */
const multisig = Signer.multisig(M_KEY, [Signer.fromKeypair(members[2]!), Signer.fromKeypair(members[0]!)])
const bytesFor = (sender: string) => offline({ sender, payment: [], inputs: [] })
const aliasesOf = (address: string, set: ReadonlyArray<string>): FakeObject => ({
  objectId: aliasesId(address),
  type: ADDRESS_ALIASES_TYPE,
  version: 2n,
  owner: { $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { owner: address, startVersion: "2" } },
  content: AddressAliasesBcs.serialize({ id: aliasesId(address), aliases: { contents: [...set] } }).toBytes()
})

describe("keys", () => {
  const ED_PHRASE = "film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm"
  const vectors = [
    ["ED25519", ED_PHRASE, "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133", Ed25519Keypair],
    ["Secp256k1", "result crisp session latin must fruit genuine question prevent start coconut brave speak student dismiss", "0x7ec1b6df34a4018c377109851af1cf70db6687dd4a880a51f9119af86d855643", Secp256k1Keypair],
    ["Secp256r1", "act wing dilemma glory episode region allow mad tourist humble muffin oblige", "0x4a822457f1970468d38dae8e63fb60eefdaa497d74d781f581ea2d137ec36f3a", Secp256r1Keypair]
  ] as const
  for (const [scheme, phrase, address, Keypair] of vectors) {
    test(`fromMnemonic derives the SDK's ${scheme} account, on the standard path and on account 3`, async () => {
      const signer = await runPure(Signer.fromMnemonic(phrase, { scheme }))
      expect([signer.address, signer.scheme]).toEqual([address, scheme] as never)
      const publicKey = await verifyPersonalMessageSignature(message, await runPure(signer.signPersonalMessage(message)))
      expect(publicKey.toSuiAddress()).toBe(address)
      const third = await runPure(Signer.fromMnemonic(Redacted.make(phrase), { scheme, account: 3 }))
      expect<string>(third.address).toBe(Keypair.deriveKeypair(phrase, Signer.derivationPath(scheme, 3)).toSuiAddress())
    })
  }

  test("a phrase one word off is refused before anything is derived, never quoting a word", async () => {
    const words = ED_PHRASE.split(" ")
    const other = wordlist.find((word) => word !== words.at(-1) && !validateMnemonic([...words.slice(0, -1), word].join(" "), wordlist))!
    const typo = [...words.slice(0, -1), other].join(" ")
    // The SDK derives it without complaint: this is the bug being guarded.
    expect(Ed25519Keypair.deriveKeypair(typo).toSuiAddress()).toMatch(/^0x[0-9a-f]{64}$/)
    const error = await failPure(Signer.fromMnemonic(typo))
    expect([error.reason, SuiError.outcome(error), error.message.includes(other)]).toEqual(["invalidMnemonic", "not_applied", false])
    words[4] = "notaword"
    const unknown = await failPure(Signer.fromMnemonic(words.join(" ")))
    expect([unknown.message.includes("word 5"), SuiError.describe(unknown).includes("notaword")]).toEqual([true, false])
    expect((await runPure(Signer.fromMnemonic(`  ${ED_PHRASE.toUpperCase().split(" ").join("   \n")}  `))).address).toBe(SuiAddress.make(vectors[0][2]))
  })

  test("a wrong word count, path or account is a typed failure; the standard paths are the SDK's", async () => {
    const reasons = await Promise.all([
      failPure(Signer.fromMnemonic("abandon abandon abandon")),
      failPure(Signer.fromMnemonic(ED_PHRASE, { path: "m/54'/784'/0'/0/0" })),
      failPure(Signer.fromMnemonic(ED_PHRASE, { account: 1.5 }))
    ])
    expect(reasons.map((e) => e.reason)).toEqual(["invalidMnemonic", "invalidPath", "invalidPath"])
    expect([Signer.derivationPath("ED25519"), Signer.derivationPath("Secp256k1", 7), Signer.derivationPath("Secp256r1", 2)]).toEqual([
      "m/44'/784'/0'/0'/0'",
      "m/54'/784'/7'/0/0",
      "m/74'/784'/2'/0/0"
    ])
  })

  test("generateMnemonic answers a valid redacted phrase; without crypto it is KeyError unavailable", async () => {
    const phrase = await runPure(Signer.generateMnemonic(24))
    expect([String(phrase).includes(" "), Redacted.value(phrase).split(" ").length, validateMnemonic(Redacted.value(phrase), wordlist)]).toEqual([false, 24, true])
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true })
    try {
      expect((await failPure(Signer.generateMnemonic())).reason).toBe("unavailable")
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "crypto", original)
    }
  })

  test("fromSecretKey reads Bech32, a hex seed and bytes, copying the caller's buffer (the SDK's ECDSA keypairs alias it)", async () => {
    const k1 = Secp256k1Keypair.generate()
    const raw = Uint8Array.from(decodeSuiPrivateKey(k1.getSecretKey()).secretKey)
    const signers = await Promise.all([
      runPure(Signer.fromSecretKey(Redacted.make(k1.getSecretKey()))),
      runPure(Signer.fromSecretKey(`0x${Buffer.from(raw).toString("hex")}`, { scheme: "Secp256k1" })),
      runPure(Signer.fromSecretKey(raw, { scheme: "Secp256k1" }))
    ])
    expect(signers.every((s) => s.address === k1.toSuiAddress())).toBe(true)
    raw.fill(0)
    expect((await verifyPersonalMessageSignature(message, await runPure(signers[2]!.signPersonalMessage(message)))).toSuiAddress()).toBe(k1.toSuiAddress())
    const aliased = Uint8Array.from(decodeSuiPrivateKey(Secp256k1Keypair.generate().getSecretKey()).secretKey)
    const direct = Secp256k1Keypair.fromSecretKey(aliased)
    const before = direct.getSecretKey()
    aliased[0] = (aliased[0] ?? 0) ^ 1
    expect(direct.getSecretKey()).not.toBe(before)
  })

  test("a corrupted secret key leaks no run of itself into the message or the JSON; a contradicting scheme is refused", async () => {
    const secret = new Ed25519Keypair().getSecretKey()
    const corrupted = `${secret.slice(0, -1)}${secret.endsWith("q") ? "p" : "q"}`
    const error = await failPure(Signer.fromSecretKey(corrupted))
    const printed = `${error.message}\n${JSON.stringify(SuiError.toJson(error))}\n${String(error)}`
    const leaked: Array<string> = []
    for (let start = "suiprivkey1".length; start + 9 <= corrupted.length; start++) if (printed.includes(corrupted.slice(start, start + 9))) leaked.push(corrupted.slice(start, start + 9))
    expect([error.reason, leaked]).toEqual(["invalidSecretKey", []])
    expect((await failPure(Signer.fromSecretKey(secret, { scheme: "Secp256k1" }))).reason).toBe("unsupportedScheme")
  })

  test("fromSecretKey reads an MLDSA65 key on an SDK that ships it, and SUI_PRIVATE_KEY through Config.Redacted", async () => {
    const mod: { MLDSA65Keypair: { generate: () => Ed25519Keypair } } | undefined = await import("@mysten/sui/keypairs/mldsa65" as string).catch(() => undefined)
    if (mod !== undefined) {
      const mldsa = mod.MLDSA65Keypair.generate()
      expect<string>((await runPure(Signer.fromSecretKey(mldsa.getSecretKey()))).scheme).toBe("MLDSA65")
    }
    const key = new Ed25519Keypair()
    const signer = await runPure(Config.Redacted("SUI_PRIVATE_KEY").pipe(
      Effect.flatMap(Signer.fromSecretKey),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SUI_PRIVATE_KEY: key.getSecretKey() } })))
    ))
    expect(signer.address).toBe(SuiAddress.make(key.toSuiAddress()))
  })
})

describe("signer values", () => {
  test("fromSdkSigner wraps any SDK signer and exposes no secret", async () => {
    const inner = keypair(9)
    class Device extends SdkSigner {
      override sign(data: Uint8Array) {
        return inner.sign(data)
      }
      override getKeyScheme(): SignatureScheme {
        return inner.getKeyScheme()
      }
      override getPublicKey(): PublicKey {
        return inner.getPublicKey()
      }
    }
    const signer = Signer.fromSdkSigner(new Device())
    expect(await runPure(signer.signTransaction(message))).toBe(Signature.make((await inner.signTransaction(message)).signature))
    expect(JSON.stringify(signer)).not.toContain(inner.getSecretKey())
  })

  test("remote decodes what it is given; no personal-message signer, or its failure, is a SigningError", async () => {
    const signer = Signer.remote({ address: SuiAddress.make(PADDED("ab")), scheme: "ED25519", signTransaction: () => Effect.succeed("AQID") })
    expect(await runPure(signer.signTransaction(message))).toBe(Signature.make("AQID"))
    expect(await failPure(signer.signPersonalMessage(message))).toBeInstanceOf(SigningError)
    const refusing = Signer.remote({ address: SuiAddress.make(PADDED("ab")), scheme: "ED25519", signTransaction: () => Effect.fail(new SigningError({ cause: "kms" })) })
    expect((await failPure(refusing.signTransaction(message)))._tag).toBe("SigningError")
  })

  test("ephemeral is a fresh key every time", async () => {
    const [a, b] = await Promise.all([runPure(Signer.ephemeral), runPure(Signer.ephemeral)])
    expect(a.address).not.toBe(b.address)
  })
})

describe("Signer.multisig", () => {
  test("combines in member order: the SDK's order-keeping combine of the same partial signatures does not verify", async () => {
    const bytes = await bytesFor(M)
    const [signature, publicKey, wrongOrder] = await run(Effect.gen(function*() {
      const signer = yield* multisig
      const signature = yield* signer.signTransaction(bytes)
      const partial = [
        (yield* Effect.promise(() => members[2]!.signTransaction(bytes))).signature,
        (yield* Effect.promise(() => members[0]!.signTransaction(bytes))).signature
      ]
      return [
        signature,
        yield* Verify.verifyTransactionSignature(bytes, signature, { address: M }),
        yield* Effect.flip(Verify.verifyTransactionSignature(bytes, M_KEY.combinePartialSignatures(partial), { address: M }))
      ] as const
    }))
    const parsed = parseSerializedSignature(signature)
    expect([addressOf(publicKey), parsed.signatureScheme === "MultiSig" && parsed.multisig.bitmap, wrongOrder._tag]).toEqual([M, 0b101, "SigningError"])
  })

  test("refuses a non-member, a duplicate member and too little weight as KeyError { invalidMultisig }", async () => {
    const errors = await Promise.all([
      failPure(Signer.multisig(M_KEY, [Signer.fromKeypair(members[0]!), stranger])),
      failPure(Signer.multisig(M_KEY, [Signer.fromKeypair(members[0]!), Signer.fromKeypair(members[0]!)])),
      failPure(Signer.multisig(M_KEY, [Signer.fromKeypair(members[1]!)]))
    ])
    expect(errors.map((e) => [e.reason, e.outcome])).toEqual(Array(3).fill(["invalidMultisig", "not_applied"]))
    expect([errors[0]!.message.includes(stranger.address), errors[2]!.message.includes("threshold is 2")]).toEqual([true, true])
  })

  test("signs a personal message that verifies as the multisig", async () => {
    const publicKey = await run(Effect.gen(function*() {
      const signer = yield* multisig
      return yield* Verify.verifyPersonalMessageSignature(message, yield* signer.signPersonalMessage(message), { address: M })
    }))
    expect(addressOf(publicKey)).toBe(M)
  })

  test("a passkey member (the SDK's PasskeyKeypair) lands on its bit and verifies", async () => {
    const authenticator = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(5))
    const raw = authenticator.getPublicKey().toRawBytes()
    const publicKey = MultiSigPublicKey.fromPublicKeys({ threshold: 2, publicKeys: [{ publicKey: members[1]!.getPublicKey(), weight: 1 }, { publicKey: new PasskeyPublicKey(raw), weight: 1 }] })
    const bytes = await bytesFor(publicKey.toSuiAddress())
    const [signature, verified] = await run(Effect.gen(function*() {
      const signer = yield* Signer.multisig(publicKey, [Signer.fromSdkSigner(new PasskeyKeypair(raw, passkeyProvider(authenticator))), Signer.fromKeypair(members[1]!)])
      const signature = yield* signer.signTransaction(bytes)
      return [signature, yield* Verify.verifyTransactionSignature(bytes, signature, { address: signer.address })] as const
    }))
    const parsed = parseSerializedSignature(signature)
    expect(addressOf(verified)).toBe(normalizeSuiAddress(publicKey.toSuiAddress()))
    expect(parsed.signatureScheme === "MultiSig" && parsed.multisig.sigs.map((sig) => Object.keys(sig).find((k) => k !== "$kind"))).toEqual(["ED25519", "Passkey"])
  })

  test("a zkLogin member signs on its bit, and its maxEpoch bounds the multisig's", async () => {
    const zkPublicKey = toZkLoginPublicIdentifier(BigInt(zk.seed), zk.iss, { legacyAddress: false })
    const publicKey = MultiSigPublicKey.fromPublicKeys({ threshold: 2, publicKeys: [{ publicKey: zkPublicKey, weight: 1 }, { publicKey: members[1]!.getPublicKey(), weight: 1 }] })
    const bytes = await bytesFor(publicKey.toSuiAddress())
    const [signature, maxEpoch] = await runPure(Effect.gen(function*() {
      const member = yield* Signer.zkLogin({ address: zk.address, inputs: zk.inputs, maxEpoch: EPOCH + 1n, ephemeralSigner: zk.ephemeral })
      const signer = yield* Signer.multisig(publicKey, [Signer.fromKeypair(members[1]!), member])
      return [yield* signer.signTransaction(bytes), signer.maxEpoch] as const
    }))
    const parsed = parseSerializedSignature(signature)
    expect([maxEpoch, parsed.signatureScheme === "MultiSig" && parsed.multisig.bitmap]).toEqual([EPOCH + 1n, 0b11])
  })
})

describe("Signer.zkLogin", () => {
  test("refuses bytes valid only after its maxEpoch: SigningError { expired }", async () => {
    const signer = await runPure(Signer.zkLogin({ address: zk.address, inputs: zk.inputs, maxEpoch: EPOCH - 1n, ephemeralSigner: zk.ephemeral }))
    const error = await failPure(signer.signTransaction(await bytesFor(zk.address)))
    expect([error.reason, signer.maxEpoch]).toEqual(["expired", EPOCH - 1n])
    const open = await runPure(Signer.zkLogin({ address: zk.address, inputs: zk.inputs, maxEpoch: EPOCH, ephemeralSigner: zk.ephemeral }))
    expect(parseSerializedSignature(await runPure(open.signTransaction(await bytesFor(zk.address)))).signatureScheme).toBe("ZkLogin")
  })
})

describe("Signer.alias", () => {
  test("signs as the account with the alias's key, refuses personal messages, and is a no-op for the address's own signer", async () => {
    const [aliased, refused] = await runPure(Effect.gen(function*() {
      const aliased = Signer.alias(A, yield* multisig)
      return [aliased, yield* Effect.flip(aliased.signPersonalMessage(message))] as const
    }))
    expect([aliased.address, aliased.alias, aliased.scheme, refused.reason]).toEqual([A, M, "MultiSig", "unavailable"] as never)
    expect(Signer.alias(A, account)).toBe(account)
  })

  test("Tx.sign compares the account offline: an alias signer signs A's bytes, M's own signer does not", async () => {
    const [signed, refused, reads] = await run(Effect.gen(function*() {
      const built = yield* Tx.fromBytes(yield* Effect.promise(() => bytesFor(A)))
      const m = yield* multisig
      return [yield* Tx.sign(built, Signer.alias(A, m)), yield* Effect.flip(Tx.sign(built, m)), (yield* SuiTest.calls("getObjects")).length] as const
    }))
    expect([signed.sender, refused._tag, reads]).toEqual([A, "SigningError", 0] as never)
  })
})

describe("the alias set", () => {
  test("aliasesId is the object derived from 0xa at AliasKey(address)", () => {
    expect<string>(aliasesId(A)).toBe(normalizeSuiAddress(deriveObjectID(ADDRESS_ALIAS_STATE_ID, "0x2::address_alias::AliasKey", aliasKey(A))))
    expect(aliasesId("0x2")).toBe(aliasesId(PADDED("2")))
  })

  test("getAliases reads the object: NotEnabled without it, Enabled with its set; allows is the address until enabled, then the set", async () => {
    const [before, after] = await run(Effect.gen(function*() {
      const before = yield* AddressAlias.getAliases(A)
      yield* SuiTest.putObject(aliasesOf(A, [M]))
      return [before, yield* AddressAlias.getAliases(A)] as const
    }))
    expect(before._tag).toBe("NotEnabled")
    expect(after._tag === "Enabled" && after.aliases).toEqual([M])
    expect([allows(before, A), allows(before, M), allows(after, A), allows(after, M)]).toEqual([true, false, false, true])
  })

  test("requireSigner refuses a key outside the set; an unreadable or undecodable object is a TransportError, neither verdict", async () => {
    const refused = await fail(Effect.andThen(SuiTest.putObject(aliasesOf(A, [M])), AddressAlias.requireSigner(A, stranger.address)))
    expect(refused._tag === "PolicyDenied" && refused.rule).toBe("alias.signer")
    const garbled = await fail(Effect.andThen(SuiTest.putObject({ ...aliasesOf(A, [M]), content: new Uint8Array(3) }), AddressAlias.requireSigner(A, M)))
    expect(garbled._tag).toBe("TransportError")
  })

  test("the recipes call 0x2::address_alias's entry functions, one command each", () => {
    const tx = new Transaction()
    AddressAlias.enable()(tx)
    AddressAlias.add({ address: A, alias: M })(tx)
    AddressAlias.remove({ address: A, alias: A })(tx)
    AddressAlias.replaceAll({ address: A, aliases: [M] })(tx)
    expect(tx.getData().commands.map((c) => `${c.MoveCall?.module}::${c.MoveCall?.function}`)).toEqual([
      "address_alias::enable",
      "address_alias::add",
      "address_alias::remove",
      "address_alias::replace_all"
    ])
  })

  test("Tx.attach accepts a member's signature on A's bytes, refuses it when A does not list it, and reads nothing for A's own", async () => {
    const bytes = await bytesFor(A)
    const signature = await runPure(Effect.flatMap(multisig, (m) => m.signTransaction(bytes)))
    const [listed, reads] = await run(Effect.gen(function*() {
      yield* SuiTest.putObject(aliasesOf(A, [M]))
      const listed = yield* Tx.attach(yield* Tx.fromBytes(bytes), signature)
      const before = (yield* SuiTest.calls("getObjects")).length
      yield* Tx.attach(yield* Tx.fromBytes(bytes), yield* account.signTransaction(bytes))
      return [listed, (yield* SuiTest.calls("getObjects")).length - before] as const
    }))
    expect([listed.sender, listed.signatures, reads]).toEqual([A, [signature], 0] as never)
    const refused = await fail(Effect.flatMap(Tx.fromBytes(bytes), (built) => Tx.attach(built, signature)))
    expect(refused._tag === "PolicyDenied" && refused.rule).toBe("alias.signer")
  })

  test("Verify with checkAddressAliases answers a validator's question: always one read, own key refused once A removed itself", async () => {
    const bytes = await bytesFor(A)
    const result = await run(Effect.gen(function*() {
      const check = (signature: Signature) => Verify.verifyTransactionSignature(bytes, signature, { address: A, checkAddressAliases: true })
      const ownBefore = yield* check(yield* account.signTransaction(bytes))
      yield* SuiTest.putObject(aliasesOf(A, [M]))
      const m = yield* multisig
      return {
        ownBefore,
        viaM: yield* check(yield* m.signTransaction(bytes)),
        own: yield* Effect.flip(check(yield* account.signTransaction(bytes))),
        strange: yield* Effect.flip(check(yield* stranger.signTransaction(bytes))),
        strict: yield* Effect.flip(Verify.verifyTransactionSignature(bytes, yield* m.signTransaction(bytes), { address: A }))
      }
    }))
    expect([addressOf(result.ownBefore), addressOf(result.viaM), result.own._tag, result.strange._tag, result.strict._tag]).toEqual([A, M, "PolicyDenied", "PolicyDenied", "SigningError"])
  })
})

describe("Verify", () => {
  test("answers the signer's public key for each local scheme; other bytes, another address, garbage or the other intent is a SigningError", async () => {
    const bytes = await offline()
    for (const kp of [new Ed25519Keypair(), new Secp256k1Keypair(), new Secp256r1Keypair()]) {
      const signature = await runPure(Signer.fromKeypair(kp).signTransaction(bytes))
      const publicKey = await run(Verify.verifyTransactionSignature(bytes, signature, { address: SuiAddress.make(kp.toSuiAddress()) }))
      expect(publicKey.toSuiAddress()).toBe(kp.toSuiAddress())
    }
    const signature = await runPure(account.signTransaction(bytes))
    const personal = await runPure(account.signPersonalMessage(bytes))
    const errors = await Promise.all([
      fail(Verify.verifyTransactionSignature(await offline({ nonce: 99 }), signature)),
      fail(Verify.verifyTransactionSignature(bytes, signature, { address: stranger.address })),
      fail(Verify.verifyTransactionSignature(bytes, Signature.make("AAAA"))),
      fail(Verify.verifyTransactionSignature(bytes, personal)),
      fail(Verify.verifyPersonalMessageSignature(bytes, signature))
    ])
    expect(errors.map((e) => e._tag)).toEqual(Array(5).fill("SigningError"))
    expect(String((errors[1] as SigningError).cause)).toContain(account.address)
  })

  describe("a zkLogin signature, verified by the node", () => {
    const signatureOf = async (data: Uint8Array) =>
      getZkLoginSignature({ inputs: zk.inputs, maxEpoch: "10", userSignature: (await zk.ephemeral.signTransaction(data)).signature })
    const node = (answer: () => Promise<{ success: boolean; errors: Array<string> }>, seen: Array<unknown>) => {
      const client = {
        network: "localnet",
        core: {
          verifyZkLoginSignature: (options: { intentScope: string; signal?: AbortSignal }) => (seen.push([options.intentScope, options.signal instanceof AbortSignal]), answer())
        }
      } as unknown as ClientWithCoreApi
      const core = Layer.effect(SuiCore, Effect.map(SuiCore, (c) => ({ ...c, getChainIdentifier: () => Effect.succeed({ chainIdentifier: CHAIN }) }))).pipe(
        Layer.provide(SuiCore.layerFromClient(client))
      )
      return Sui.layerNoDeps.pipe(Layer.provide(core))
    }
    const on = <A, E>(layer: Layer.Layer<Sui, unknown>, effect: Effect.Effect<A, E, Sui>) => Effect.runPromise(Effect.exit(Effect.provide(effect, layer)))

    test("yes is the public key, asked with the right intent and the Effect's signal; no is a SigningError; unreachable a TransportError", async () => {
      const bytes = new Uint8Array([10, 20, 30])
      const signature = await signatureOf(bytes)
      const seen: Array<unknown> = []
      const yes = await on(node(async () => ({ success: true, errors: [] }), seen), Verify.verifyTransactionSignature(bytes, signature, { address: zk.address }))
      const no = await on(node(async () => ({ success: false, errors: ["bad proof"] }), seen), Verify.verifyPersonalMessageSignature(bytes, signature))
      const down = await on(node(async () => Promise.reject(Object.assign(new Error("refused"), { code: "UNAVAILABLE" })), seen), Verify.verifyTransactionSignature(bytes, signature))
      expect(Exit.isSuccess(yes) && yes.value.toSuiAddress()).toBe(zk.address)
      expect(seen.slice(0, 2)).toEqual([["TransactionData", true], ["PersonalMessage", true]])
      expect(Exit.isFailure(no) && (Option.getOrThrow(Exit.findErrorOption(no)) as { _tag: string })._tag).toBe("SigningError")
      expect(Exit.isFailure(down) && Option.getOrThrow(Exit.findErrorOption(down))).toMatchObject({ _tag: "TransportError", method: "verifyTransactionSignature", retryable: true })
    })
  })
})

/** A zkLogin account, with a placeholder proof: signature assembly only. */
const zk = (() => {
  const iss = "https://accounts.google.com"
  const base64Url = (text: string) => toBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const seed = genAddressSeed(BigInt(1234), "sub", "user-1", "client-1").toString()
  return {
    iss,
    seed,
    inputs: {
      proofPoints: { a: ["1", "2", "1"], b: [["1", "0"], ["1", "0"], ["1", "0"]], c: ["1", "2", "1"] },
      issBase64Details: { value: base64Url(`"iss":"${iss}",`), indexMod4: 0 },
      headerBase64: base64Url("{\"alg\":\"RS256\"}"),
      addressSeed: seed
    },
    address: SuiAddress.make(computeZkLoginAddressFromSeed(BigInt(seed), iss, false)),
    ephemeral: Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
  }
})()

/** `AliasKey(address)`'s BCS: the padded address. */
const aliasKey = (address: string) => Uint8Array.from(Buffer.from(normalizeSuiAddress(address).slice(2), "hex"))

/** A software P-256 authenticator answering WebAuthn `get` the way a browser does. */
const passkeyProvider = (authenticator: Secp256r1Keypair): PasskeyProvider => {
  const der = (compact: Uint8Array) => {
    const integer = (raw: Uint8Array) => {
      let start = 0
      while (start < raw.length - 1 && raw[start] === 0) start++
      const trimmed = raw.slice(start)
      const body = (trimmed[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...trimmed]) : trimmed
      return [0x02, body.length, ...body]
    }
    const sequence = [...integer(compact.slice(0, 32)), ...integer(compact.slice(32))]
    return Uint8Array.from([0x30, sequence.length, ...sequence])
  }
  const buffer = (raw: Uint8Array) => raw.slice().buffer as ArrayBuffer
  return {
    create: () => Promise.reject(new Error("not used")),
    get: async (challenge: Uint8Array) => {
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({
        type: "webauthn.get",
        challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        origin: "https://miso.test"
      }))
      const authenticatorData = new Uint8Array(37).fill(1)
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON))
      const payload = Uint8Array.from([...authenticatorData, ...digest])
      return {
        response: { authenticatorData: buffer(authenticatorData), clientDataJSON: buffer(clientDataJSON), signature: buffer(der(await authenticator.sign(payload))) }
      } as unknown as Awaited<ReturnType<PasskeyProvider["get"]>>
    }
  }
}
