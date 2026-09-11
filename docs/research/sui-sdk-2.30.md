# Sui TypeScript SDK (@mysten/sui) v2.30.0 research map

Researched 2026-09-11 against the installed copy in `m2m/node_modules/@mysten/sui` (2.30.0, which is also npm `latest`; no 3.x exists). All paths below are relative to `dist/` in that package.

## 1. Entry points / subpath exports

There is **no `./experimental` export in 2.x** (folded into `./client` at 2.0.0).

- `@mysten/sui/bcs` → `bcs` schema namespace, `BcsType`/`BcsStruct`/`BcsEnum`/`BcsTuple` builders, `TypeTagSerializer`, `compareBcsBytes`, `pureBcsSchemaFromTypeName`, type helpers (`PureTypeName`, `ShapeFromPureTypeName`, `TypeTag`).
- `@mysten/sui/client` → **only the transport-neutral Core API**: `BaseClient`, `CoreClient`, `ClientWithCoreApi`, `ClientCache`, error classes (`SuiClientError`, `SimulationError`, `ObjectError`, `TransactionError`), `SuiClientTypes` namespace, `NamedPackagesOverrides`, BCS-parsing helpers (`parseTransactionBcs`, `parseTransactionEffectsBcs`, `extractStatusFromEffectsBcs`, `formatMoveAbortMessage`). **No concrete client class is exported here.**
- `@mysten/sui/jsonRpc` → `SuiJsonRpcClient`, `JSONRpcCoreClient`, `JsonRpcHTTPTransport`, errors (`SuiHTTPTransportError`, `JsonRpcError`, `SuiHTTPStatusError`), `getJsonRpcFullnodeUrl`. **Every exported member is `@deprecated`.**
- `@mysten/sui/grpc` → `SuiGrpcClient`, `GrpcCoreClient`, `GrpcWebFetchTransport`, `RpcError`, `GrpcStatusCode`, plus generated protobuf service clients (`TransactionExecutionServiceClient`, `LedgerServiceClient`, `StateServiceClient`, `SubscriptionServiceClient`, `MovePackageServiceClient`, `SignatureVerificationServiceClient`, `NameServiceClient`, `ForkingServiceClient`) under `grpc/proto/**`.
- `@mysten/sui/graphql` → `SuiGraphQLClient`, `GraphQLCoreClient`, `SuiGraphQLRequestError`, `isSuiGraphQLClient`. `@mysten/sui/graphql/schema` → single unified generated schema.
- `@mysten/sui/transactions` → `Transaction`, `TransactionCommands`, `Inputs`, `TransactionDataBuilder`, executors, object cache, intents (`coinWithBalance`).
- `@mysten/sui/cryptography` → `Signer`, `Keypair` abstract classes, `PublicKey`, `decodeSuiPrivateKey`/`encodeSuiPrivateKey`, `messageWithIntent`, `IntentScope`, `SignatureScheme`, mnemonic helpers.
- `@mysten/sui/keypairs/ed25519`, `/secp256k1`, `/secp256r1`, `/passkey`; `@mysten/sui/multisig`; `@mysten/sui/verify`; `@mysten/sui/zklogin`; `@mysten/sui/faucet`; `@mysten/sui/utils` (address/type formatting, constants, MVR helpers, dynamic-field/derived-object ID helpers).

## 2. The client story

Sui 2.x is built around a **transport-neutral Core API** (`client/core.d.mts`). `BaseClient` holds `network`, `cache: ClientCache`, and `$extend(...)` for SDK extensions. `CoreClient extends BaseClient implements SuiClientTypes.TransportMethods` and declares:

`getObjects`, `getObject`, `listCoins`, `listOwnedObjects`, `getBalance`, `listBalances`, `getCoinMetadata`, `getTransaction`, `executeTransaction`, `simulateTransaction`, `getReferenceGasPrice`, `getCurrentSystemState`, `getProtocolConfig`, `getChainIdentifier`, `listDynamicFields`, `listTransactions`, `listEvents`, `resolveTransactionPlugin`, `verifyZkLoginSignature`, `getMoveFunction`, `defaultNameServiceName`, `resolveNameServiceAddress`; plus concrete conveniences `getDynamicField`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction`.

Every method's options extend `CoreClientMethodOptions { signal?: AbortSignal }`.

Three transports implement it:
- **`SuiGrpcClient`** (`grpc/client.d.mts`): options `{ network, mvr? } & ({ transport: RpcTransport } | GrpcWebOptions)` (GrpcWebOptions: baseUrl, meta, timeout, interceptors, format...). Also exposes raw generated service clients (`ledgerService`, `stateService`, `subscriptionService`, ...).
- **`SuiGraphQLClient`**: options `{ url, fetch?, headers?, queries?, network, mvr? }`; has generic `.query()`/`.execute()`.
- **`SuiJsonRpcClient`**: deprecated wholesale, legacy surface only.

**Recommended default:** gRPC. `network: 'mainnet' | 'testnet' | 'devnet' | 'localnet' | (string & {})` is a **required** constructor option on every client. No built-in default-URL-by-network helper exists for gRPC/GraphQL (only `getJsonRpcFullnodeUrl` for JSON-RPC).

**MVR** is built into transaction resolution. `CoreClientOptions.mvr?: { url?, pageSize?, overrides?: { packages?, types? } }`; every client exposes `client.mvr` with `resolvePackage`, `resolveType`, `resolve`.

## 3. Transactions

`Transaction` (`transactions/Transaction.d.mts`):
- Commands: `moveCall({package,module,function}|{target}, arguments?, typeArguments?)`, `splitCoins`, `mergeCoins`, `transferObjects`, `publish({modules, dependencies})`, `upgrade`, `makeMoveVec`. Helpers `coin({type?, balance, useGasCoin?})`, `balance(...)`, `withdrawal({amount, type?})` (address-balance `FundsWithdrawal` inputs).
- `Inputs`: `Pure`, `ObjectRef`, `SharedObjectRef`, `ReceivingRef`, `FundsWithdrawal`. Low-level constructors in `TransactionCommands`. `UpgradePolicy` enum.
- **Plugins:** `addSerializationPlugin`, `addBuildPlugin`, `addIntentResolver(intent, resolver)`. `TransactionPlugin = (transactionData: TransactionDataBuilder, options: BuildTransactionOptions, next: () => Promise<void>) => Promise<void>` (CPS middleware). Built-in intent `coinWithBalance`.
- Build/sign: `setSender`/`setSenderIfNotSet`, `setExpiration`, `setGasPrice`, `setGasBudget`/`setGasBudgetIfNotSet`, `setGasOwner`, `setGasPayment(ObjectRef[])`. `getData()`, `toJSON()` (`serialize()` deprecated). `build(options?): Promise<Uint8Array>`, `sign({signer, ...}): Promise<SignatureWithBytes>`, `getDigest(options?)`. `isPreparedForSerialization()` vs `isFullyResolved()`.
- `Transaction.from(string | Uint8Array | TransactionLike, options?)`, `Transaction.fromKind(bytes)`.
- `BuildTransactionOptions = { client?: ClientWithCoreApi, onlyTransactionKind?, assumeSufficientAddressBalances? }` (last flag new in 2.30.0).
- `TransactionDataBuilder`: `fromKindBytes`, `fromBytes`, `restore`, `getDigestFromBytes`; fields `version: 2`, `sender`, `expiration`, `gasData`, `inputs`, `commands`; methods `build`, `addInput`, `getInputUses`, `mapArguments`, `replaceCommand`, `insertTransaction`, `getDigest`, `snapshot`, `shallowClone`, `applyResolvedData`.
- Executors: `ParallelTransactionExecutor` / `SerialTransactionExecutor` accept any `ClientWithCoreApi`, with `gasMode: 'coins' | 'addressBalance'`.
- Dry-run/dev-inspect are only on the deprecated JSON-RPC client; Core API equivalent is `simulateTransaction` (`checksEnabled: false` for dev-inspect-like relaxed validation; `include.commandResults` for return values).
- `signAndExecuteTransaction({transaction: Uint8Array|Transaction, signer, additionalSignatures?, include?})`.
- `executeTransaction({transaction: Uint8Array, signatures: string[], include?, signal?})`.
- `waitForTransaction({digest | result, include?, timeout?, pollSchedule?: number[], signal?})`. `pollSchedule` is absolute ms offsets, e.g. `[0, 300, 600, 1500]`.

## 4. Keypairs and signing

`cryptography/keypair.d.mts`: `abstract class Signer` with `abstract sign(bytes)`, `signWithIntent`, `signTransaction(bytes)`, `signPersonalMessage(bytes)`, `signAndExecuteTransaction({transaction, client})`, `toSuiAddress()`, `abstract getKeyScheme()`, `abstract getPublicKey()`. `abstract class Keypair extends Signer` adds `getSecretKey(): string` (Bech32 `suiprivkey1...`). `decodeSuiPrivateKey(value): { scheme, secretKey }`, `encodeSuiPrivateKey(bytes, scheme)`.

Concrete: `Ed25519Keypair`, `Secp256k1Keypair`, `Secp256r1Keypair`, `PasskeyKeypair`, `MultiSigSigner`, `ZkLoginSigner`. Mnemonics: `mnemonicToSeed(Hex)`, SLIP-0010 path `m/44'/784'/{a}'/{c}'/{i}'`.

`SIGNATURE_SCHEME_TO_FLAG = {ED25519:0, Secp256k1:1, Secp256r1:2, MultiSig:3, ZkLogin:5, Passkey:6}`. `parseSerializedSignature` returns a discriminated union by `signatureScheme`.

## 5. Errors

- Core (`client/errors.d.mts`): `SuiClientError extends Error`; `SimulationError` (`executionError?: SuiClientTypes.ExecutionError`); `ObjectError` (`code: string` transport-specific, `reason: 'notFound' | 'deleted' | 'unknown'`, `objectId?`, `cause?`); `TransactionError` (`reason: 'notFound'`, `digest`, `cause?`).
- JSON-RPC (deprecated): `SuiHTTPTransportError`, `JsonRpcError` (`code`, `type`), `SuiHTTPStatusError` (`status`, `statusText`).
- gRPC: `RpcError` and `GrpcStatusCode` re-exported from `@protobuf-ts/runtime-rpc`. Aborted calls report `DEADLINE_EXCEEDED` (AbortSignal.timeout) or `CANCELLED`.

**Failed execution shape:**

```ts
type ExecutionStatus = { success: true; error: null } | { success: false; error: ExecutionError }
type ExecutionError = { message: string; command?: number } & EnumOutputShape<{
  MoveAbort: { abortCode: string; location?: { package?, module?, function?: number, functionName?, instruction? }; cleverError?: { errorCode?, lineNumber?, constantName?, constantType?, value? } }
  SizeError: { name; size; maxSize }
  CommandArgumentError: { argument; name }
  TypeArgumentError: { typeArgument; name }
  PackageUpgradeError: { name; packageId?; digest? }
  IndexError: { index?; subresult? }
  CoinDenyListError: { name; coinType; address? }
  CongestedObjects: { name; objects: string[] }
  ObjectIdError: { name?; objectId }
  Unknown: null
}>
type TransactionResult<Include> =
  | { $kind: 'Transaction'; Transaction: Transaction<Include>; FailedTransaction?: never }
  | { $kind: 'FailedTransaction'; FailedTransaction: Transaction<Include>; Transaction?: never }
```

`formatMoveAbortMessage(options)` renders a human string; `extractStatusFromEffectsBcs(bytes)` pulls status from raw effects BCS.

## 6. Types

- Core request/response shapes: `SuiClientTypes` namespace in `client/types.d.mts` (~1000 lines): `Object<Include>`, `Coin`, `Balance`, `CoinMetadata`, `Transaction<Include>`, `TransactionEffects`, `ChangedObject`, `GasCostSummary`, `Event` (`packageId`, `module`, `sender`, `eventType`, `bcs: Uint8Array`, `json | null` with a warning that json shape varies by transport, prefer bcs), `DynamicField(Entry)`, `PackageResponse`/`ModuleResponse`/`FunctionResponse`/`DatatypeResponse`, `ObjectOwner` union (`AddressOwner | ObjectOwner | Shared | Immutable | ConsensusAddressOwner | Unknown`). **Include flags** (`ObjectInclude`, `TransactionInclude`) are conditional-typed into responses: unrequested fields are statically `undefined`.
- Legacy JSON-RPC types in `jsonRpc/types/generated.d.mts` (OpenRPC-generated, deprecated).
- BCS: `bcs` namespace (`bcs.TransactionData`, `bcs.Object`, `bcs.TransactionEffects`, builders `struct/enum/tuple/vector/option/map/lazy`). Realigned with Rust at 2.0.0.
- **valibot** is a runtime dep (transaction data validation). No zod.
- GraphQL types via graphql-codegen; gRPC types via protoc/@protobuf-ts.

## 7. Pagination, events, subscriptions, Move-type helpers

- List responses: `{ items, hasNextPage: boolean, cursor: string | null }` for coins/objects/dynamic fields; `{ transactions | events, hasNextPage, startCursor, endCursor }` for `listTransactions`/`listEvents` (`after`/`before`, `order: 'ascending' | 'descending'`, page-size cap 50; gRPC silently truncates, others throw).
- `TransactionFilter`/`EventFilter`: simple unions (`sender` xor `function`; `sender` xor `emitModule` xor `eventType`).
- **Subscriptions:** JSON-RPC WebSocket subscriptions are **removed**. Streaming lives on gRPC `SubscriptionServiceClient` (server-streaming checkpoint subscription), exposed as `SuiGrpcClient.subscriptionService`.
- Helpers (`@mysten/sui/utils`): `parseStructTag`, `normalizeStructTag`, `isValidStructTag`, `normalizeSuiAddress`/`normalizeSuiObjectId`, `isValidSuiAddress`/`isValidSuiObjectId`/`isValidTransactionDigest`, `isValidNamedPackage`/`isValidNamedType`, `deriveDynamicFieldID`, `deriveObjectID`, `formatAddress`/`formatDigest`, `parseToUnits`/`parseToMist`.

## 8. CHANGELOG direction (2.x)

2.0.0: promoted experimental unified client into `@mysten/sui/client` (dropped `Experimental_` prefixes); removed old `SuiClient` (JSON-RPC moved to `@mysten/sui/jsonRpc` as `SuiJsonRpcClient`); single GraphQL schema; removed named-packages plugin registry (MVR built in); BCS realigned with Rust; executors made transport-generic; removed 1.x deprecated surface (`fromB64`/`toB64`/..., `Transaction.blockData`, faucet v0/v1).

Post-2.0: 2.25 backfilled system-state/protocol-config/chain-id onto top-level clients; 2.26 added transport-neutral `ObjectError`/`TransactionError`; 2.27 checkpoint/timestamp metadata on tx results; 2.28 `Validity` expirations; 2.29 gRPC status decoding fix + `RpcError`/`GrpcStatusCode` exports; 2.30 `assumeSufficientAddressBalances`. dapp-kit legacy package removed in 2.26.2.

**Net trajectory:** JSON-RPC fully deprecated in-code; gRPC primary; GraphQL the flexible-query alternative; application code is meant to target `ClientWithCoreApi`/`CoreClient`.

## 9. npm status

`npm view @mysten/sui`: `latest` = 2.30.0 (modified 2026-09-09); only other tag is a rolling `experimental` prerelease.

## Design implications

The natural seam is `CoreClient`/`ClientWithCoreApi`: wrapping that one interface covers gRPC/GraphQL/JSON-RPC uniformly, including shared pagination, error subclasses, and `SuiClientTypes`. `Transaction`/`TransactionDataBuilder` is a mutable, promise-based builder whose plugin chain is CPS-style and maps naturally onto Effect middleware. `Signer`/`Keypair` are simple Promise-returning abstract classes.
