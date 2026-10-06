# TrustFlow SDK API Reference

## TrustFlowClient

Main entry point for interacting with the TrustFlow Protocol. Manages network configuration, RPC connections, and provides access to escrow operations.

### Constructor

```typescript
new TrustFlowClient(config: ClientConfig)
```

**Parameters:**
- `contractId` — Soroban contract ID for TrustFlow escrow (required)
- `network` — Network type ('TESTNET' or 'MAINNET'), defaults to TESTNET
- `rpcUrl` — Optional custom Soroban RPC URL
- `apiBaseUrl` — Optional TrustFlow API base URL for backend integration
- `apiKey` — Optional API key for authenticated requests
- `ipfs` — Optional IPFS configuration for `storage.upload()`

### Methods

- `connect()` — Establishes connection to the Stellar network and verifies connectivity
- `isConnected()` — Returns true if currently connected to the network
- `getBalance(address)` — Retrieves native XLM balance for a given Stellar address
- `getNetworkPassphrase()` — Returns the network passphrase for transaction signing
- `getConfig()` — Returns a summary of the client configuration
- `getServer()` — Returns the underlying Horizon.Server instance for advanced operations
- `getAuthHeaders()` — Creates authorization headers for API requests when apiKey is configured

### Example

```typescript
const client = new TrustFlowClient({
  contractId: process.env.CONTRACT_ID!,
  network: 'TESTNET',
  apiBaseUrl: 'https://api.trustflow.xyz',
  apiKey: process.env.API_KEY
});
await client.connect();

const balance = await client.getBalance('GDEPOSITOR...');
console.log(`Balance: ${balance} XLM`);
```

## TrustFlowEscrowClient
- `createEscrow(params)` — create a new escrow; encodes contract call arguments via `buildCreateEscrowArgs`
- `fund(escrowId, funderAddress, amountStroops, tokenAddress?)` — transfer an asset (e.g. USDC via
  its Soroban token contract) into an existing escrow to be locked until release; encodes contract
  call arguments via `buildFundArgs`. Omit `tokenAddress` to use the escrow's native asset.
- `releaseEscrow(id, signer)` — release funds to beneficiary
- `claim(escrowId, claimantAddress)` — beneficiary-side shortcut to withdraw already-cleared escrow funds
- `getEscrow(id)` — read escrow state from contract
- `getGigs(params)` — fetch paginated gigs via backend API with automatic retries for transient failures (`429`, `5xx`, network)

## disputeEscrow (`src/escrow/dispute.ts`)
- `disputeEscrow(client, { escrowId, caller, reason })` — raises a dispute directly against the
  TrustFlow contract; encodes contract call arguments via `buildDisputeArgs`. Distinct from
  `DisputeClient.raiseDispute` below, which records the dispute with the backend API instead of
  the on-chain contract.
- Importable from the package root and from the escrow subpath:
  `import { disputeEscrow } from '@trustflow/sdk'` or `from '@trustflow/sdk/escrow'`. The
  `DisputeClientOptions`, `EscrowMonitorOnError`, `EscrowMonitorErrorContext` and
  `EscrowMonitorErrorPhase` types are exported from the same entry points.

## MultiSigEscrowClient

Client for collecting M-of-N signatures on shared backend Escrow operations. Manages multi-signature workflows where multiple signers must authorize a transaction before it can be submitted.

### Constructor

```typescript
new MultiSigEscrowClient(config: ContractConfig)
```

### Flow

1. Call `initMultiSigOperation` with base unsigned XDR and signer list
2. Each authorized signer calls `addSignature` with their signed XDR
3. Poll `getMultiSigStatus` to check progress
4. Once `isReady` is true, call `submitWhenReady` to broadcast the transaction

### Methods

- `initMultiSigOperation(params)` — Initializes a new multi-sig operation for an escrow action
  - Returns `operationId` used to reference this operation in subsequent calls
  - Parameters: `escrowId`, `operationType`, `unsignedXdr`, `networkPassphrase`, `signers`, `threshold`, `expiresAt?`
  
- `addSignature(params)` — Adds a signer's contribution to a pending multi-sig operation
  - Extracts the `DecoratedSignature` from the provided XDR envelope
  - Merges it into the accumulated transaction without duplicating existing signatures
  - Parameters: `operationId`, `signerAddress`, `signedXdr`
  - Returns updated status snapshot after signature is recorded
  
- `getMultiSigStatus(operationId)` — Returns the current signature-collection status for an operation
  - Returns status including collected signatures, whether operation is ready, and expiry state
  
- `submitWhenReady(operationId, rpcClient)` — Submits the assembled transaction to Horizon once signature threshold is met
  - Only callable when `isReady` is true
  - Returns transaction hash on successful submission
  
- `getAssembledXdr(operationId)` — Assembles and returns the complete XDR with all collected signatures
  - Does not submit the transaction; useful for inspection or manual submission
  
- `listOperations()` — Returns all pending multi-sig operations

### Example

```typescript
const client = new MultiSigEscrowClient(config);

// Signer A initiates
const result = client.initMultiSigOperation({
  escrowId: 'escrow-123',
  operationType: 'release',
  unsignedXdr: '...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  signers: ['GSIGNER_A...', 'GSIGNER_B...'],
  threshold: 2,
});
const { operationId } = result.data;

// Signer A adds their signature
client.addSignature({
  operationId,
  signerAddress: 'GSIGNER_A...',
  signedXdr: '...',
});

// Signer B adds their signature
client.addSignature({
  operationId,
  signerAddress: 'GSIGNER_B...',
  signedXdr: '...',
});

// Check status
const status = client.getMultiSigStatus(operationId);
if (status.data.isReady) {
  const submitResult = await client.submitWhenReady(operationId, rpcClient);
  console.log('Transaction hash:', submitResult.data.hash);
}
```

## ProfileClient
- `new ProfileClient(apiUrl, token, options?)`
- `.getProfile(address)` — fetch a user's profile (automatic retry on transient backend failures)
- `.updateProfile(address, params)` — update a user's profile (automatic retry on transient backend failures)

## IPFSStorage
- `new IPFSStorage(config?)` — `config.apiUrl` (default: web3.storage-compatible upload API), `config.apiKey`, `config.gatewayUrl`
- `.upload(file, options?)` — uploads a `Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob` or browser `File` (a `File`'s `name` and a `Blob`'s `type` are used as the default `filename` / `contentType`); the request goes to `apiUrl` exactly as configured (no slash appended, query string kept); returns `SDKResult<{ cid, url }>`
- Also available as `client.storage.upload(file)` on `TrustFlowClient` (configure via `new TrustFlowClient({ ipfs: { apiKey } })`)

## Contract Bindings
- `client.createContractBinding(specEntries, contractId?)` — builds a spec-driven `SorobanContractClient` (`methods.*`, `read_*`, `simulate_*`); also `createContractBinding`, `SorobanSpec`, `AbstractContractClient` and `generateTypeScriptBindings` from the root entry
- See [CONTRACT_BINDINGS.md](./CONTRACT_BINDINGS.md) for obtaining spec entries, the JS-to-Soroban type-mapping table and known gaps

## EscrowBuilder
Fluent builder: `.setDepositor().setBeneficiary().setAmount().build()`

`build()` validates that `depositor`, `beneficiary` and `amountXLM` are set and returns a **snapshot copy** of the builder's params — never a reference to the builder's internal state. Later `set*` calls and mutations of an already built object therefore cannot affect the builder or any previously built object, so one builder can be reused as a template across gigs:

```typescript
const template = new EscrowBuilder().setDepositor(DEPOSITOR).setBeneficiary(BENEFICIARY);
const gigA = template.setAmount('10').build();
const gigB = template.setAmount('20').build();

gigA.amountXLM; // '10' — unaffected by gigB
```

Throws `TrustFlowError` (`VALIDATION_ERROR`) when a required field is missing.

## EscrowMonitor
- `.on(event, handler)` — subscribe to escrow events; `handler` is narrowed to that event's payload
- `.off(event, handler)` — unsubscribe (same overloads as `.on`)
- `.onError(callback)` — observe fetch/handler failures (`{ phase: 'fetch' | 'handler' }`)
- `.onReconnect(callback)` — notified when resilient polling recovers (`{ cursor, failures }`)
- `.onGapDetected(callback)` — notified of possible missed events (`{ reason, fromLedger, toLedger, cursor }`)
- `.startPolling(intervalMs, fetchFn)` — begin simple polling (backward compatible)
- `.startResilientPolling(intervalMs, fetchFn, options?)` — cursor-aware polling with backoff, dedup and gap detection
- `.startResilientRawPolling(intervalMs, contractId, fetchRaw, options?)` — same, parsing raw `getEvents` output via `parseEvents`
- `.deliver(events)` — dispatch already-parsed events to handlers
- `.stopPolling()` — stop any active polling loop

### Subscribing with a narrowed handler

`on`/`off` take a `TrustFlowEventType` literal and contextually type `event` to
that event, so `event.data` is the payload type — no second `if` narrowing:

```typescript
import { EscrowMonitor, type EventHandlerFor, type MonitorEventName } from '@trustflow/sdk';

const monitor = new EscrowMonitor();

// `e` is narrowed to the `escrow_created` event, so `data.amount` is a bigint.
monitor.on('escrow_created', (e) => {
  console.log(e.data.escrowId, e.data.amount);
});

// Another event's payload is a compile error, not a runtime `undefined`:
monitor.on('dispute_raised', (e) => {
  // Property 'amount' does not exist on type 'DisputeRaisedData'
  console.log(e.data.amount);
});

// A name the parser never emits is rejected too — a typo used to compile and
// silently never fire:
monitor.on('escrow_create', () => {}); // error TS2769

// '*' receives the whole union, so narrow it yourself or switch on `e.type`:
monitor.on('*', (e) => console.log('any event', e.type));

// The same literal removes the handler, with no cast (#228 may add an
// unsubscribe return value; the overloads here carry over to it):
const onCreated: EventHandlerFor<'escrow_created'> = (e) => void e.data.escrowId;
monitor.on('escrow_created', onCreated);
monitor.off('escrow_created', onCreated);

// A name held in a variable: type it as MonitorEventName to stay inside the
// checked surface (a plain `string` still works, but is deprecated).
const name: MonitorEventName = 'escrow_created';
monitor.on(name, (e) => void e.data);
```

The types involved — `MonitorEventName`, `EventHandlerFor<T>` and the
narrowed event itself (`ParsedEventForType<T>`) — are exported from the package
root. Untyped events (`escrow_cancelled`, `dispute_resolved`,
`milestone_completed`) carry `data: Record<string, unknown>`, so treat their
payload as unverified.

### Resilient polling (recommended for production)

Soroban RPC serves contract events through `getEvents` (cursor / `startLedger`
polling, no push WebSocket), so "reconnect" means resuming polling from the
last saved position. `startResilientPolling` handles this for you:

```typescript
import { EscrowMonitor, fetchContractEvents, parseEvents } from '@trustflow/sdk';

const monitor = new EscrowMonitor();
monitor.on('escrow_created', (e) => console.log(e.data.escrowId));
monitor.onReconnect(({ failures }) => console.log(`reconnected after ${failures} failure(s)`));
monitor.onGapDetected((gap) => console.warn('possible missed events', gap));

monitor.startResilientPolling(
  5000,
  async (cursor) => {
    const page = await fetchContractEvents(client.getSorobanServer(), { contractId, cursor });
    return parseEvents(page.events, contractId);
  },
  { store }, // optional CursorStore; in-memory by default
);
```

Behavior: resumes from the saved cursor after transient RPC failures with
exponential backoff (fetch itself reuses the shared `retry` helper), dedups
across resumes by `pagingToken`/`id`, persists the newest cursor after each
successful batch, and reports ledger discontinuities or expired cursors
(cursor older than the RPC retention window cannot be backfilled) via
`onGapDetected`.

## DisputeClient
- `.raiseDispute(params)` — raise a dispute (automatic retry on transient backend failures)
- `.getDispute(escrowId)` — get dispute status (automatic retry on transient backend failures)

## Auth

The TrustFlow backend uses a challenge-response authentication flow to issue session tokens.

### Challenge-Sign Flow

1. **Request Challenge** — Call `requestChallenge(apiUrl, address)` to get a unique signing challenge from the backend
   - Returns: `{ challenge: string; expiresAt: number; address: string }`
   - The backend generates a unique challenge string and returns an expiry timestamp
   - Throws: `TrustFlowError` with code 'CONNECTION_ERROR' if the backend is unreachable

2. **Sign Challenge** — Using your wallet adapter, sign the challenge string as raw UTF-8 bytes
   - The backend expects a raw ed25519 signature over the UTF-8-encoded challenge string, base64-encoded
   - Example with Stellar Keypair:
     ```typescript
     import { Keypair } from '@stellar/stellar-sdk';
     
     const keypair = Keypair.fromSecret(secretKey);
     const challengeBytes = Buffer.from(challenge, 'utf-8');
     const signature = keypair.sign(challengeBytes).toString('base64');
     ```
   - Or use your wallet directly:
     ```typescript
     const wallet = await connectWallet('freighter');
     const signature = await getFreighter().sign(challengeXdr, 'TESTNET');
     // (Note: Freighter expects XDR format, not raw challenge string)
     ```

3. **Verify & Get Token** — Call `verifyAndGetToken(apiUrl, address, signature)` to exchange your signature for a session token
   - Returns: `Promise<string>` (JWT/session token)
   - Throws: `TrustFlowError` with code 'UNAUTHORIZED' if the signature is invalid or verification fails

### Session Management

After obtaining a token, persist it using the session storage functions:

- `saveSession(token, address, expiresAt?)` — Persists the session token
  - Browser: uses `localStorage` automatically
  - Node/CLI/backend: uses in-memory storage by default (not persistent across restarts); call `configureSessionStorage()` to override
  
- `loadSession()` → `Session | null` — Retrieves a saved session
  - Returns null if no session exists or if it has expired
  
- `isSessionExpired(session?)` → `boolean` — Checks if a session token has passed its expiry time
  - **Note:** `expiresAt` is a client-side estimate (15 minutes by default) since the backend currently doesn't return a token TTL
  - Do not rely on this for security-sensitive decisions; always handle `401` from the backend even when this returns `false`
  - Tracked in [#82](https://github.com/trustflow-protocol/trustflow-sdk/issues/82)
  
- `clearSession()` — Removes the token from storage
  
- `configureSessionStorage(adapter)` — Override the storage backend (for Node.js durability or tests)
  ```typescript
  configureSessionStorage({
    get: (key) => myFileOrRedisStore.get(key),
    set: (key, value) => myFileOrRedisStore.set(key, value),
    remove: (key) => myFileOrRedisStore.delete(key),
  });
  ```

### Functions

- `requestChallenge(apiUrl, address, options?)` — get signing challenge with retry-aware backend transport
- `verifyAndGetToken(apiUrl, address, signature, options?)` — exchange signature for JWT with retry-aware backend transport
- `saveSession(token, address, expiresAt?)` — persist session token (auto-detects browser vs Node storage)
- `loadSession()` → `Session | null` — retrieve saved session token
- `isSessionExpired(session?)` → `boolean` — check token expiry (client-side estimate)
- `clearSession()` — remove token from storage
- `configureSessionStorage(adapter)` — override storage backend

## Wallet Module

Wallet integration utilities for connecting to Stellar wallets (Freighter, Albedo, and others) and managing connections.

### SEP-0007 transaction deep links and QR data

`generateSep7Uri(xdr, options?)` from `@trustflow/sdk/wallet` accepts a base64-encoded
`TransactionEnvelope` and returns a `web+stellar:tx` URI. Use that entire URI as a mobile
wallet deep link or the text payload of a QR code. It does not render an image or sign the request.

Options are `callbackUrl` (an absolute HTTP(S) URL encoded as a SEP-0007 `url:` callback),
`message` (at most 300 characters), `originDomain` (a fully qualified domain),
`networkPassphrase` (set this for non-public networks), and `maxUriLength` (an integer byte
cap from 1 to 2953). The default cap is `SEP7_MAX_URI_LENGTH` (2953), the maximum byte-mode
payload of a version-40 QR code at low error correction. Set a smaller cap when your QR renderer or error
correction setting requires it. Invalid input or excess length throws `TrustFlowError` with
`VALIDATION_ERROR`.

SEP-0007 wallets should display `origin_domain` only after verifying a URI signature. This
generator does not sign URI requests, so passing `originDomain` alone does not establish a
trusted origin label in a wallet.

```typescript
import { generateSep7Uri } from '@trustflow/sdk/wallet';

const uri = generateSep7Uri(preparedXdr, {
  networkPassphrase: 'Test SDF Network ; September 2015',
  message: 'Review escrow release',
});
// Use `uri` as the QR text payload or a wallet deep link.
```

### Supported Wallet Types

- `'freighter'` — Freighter browser extension (default)
- `'albedo'` — Albedo web-based signer
- `'xbull'` — xBull wallet
- `'manual'` — Manual signing (reserved for future use)

### Exported Functions

- `connectWallet(walletType?)` — Initiates connection to a specified wallet
  - `walletType` (optional): One of 'freighter', 'albedo', 'xbull', 'manual'; defaults to 'freighter'
  - Returns a `WalletConnection` (plain data object with type, publicKey, and network)
  - **Throws** `TrustFlowError` with code 'UNAUTHORIZED' if wallet not supported or not installed
  
- `disconnectWallet()` — Disconnects from the currently connected wallet
  - Most Stellar wallets don't expose a disconnect API, so this is a no-op in practice
  
- `getFreighter()` — Gets the Freighter wallet adapter (the low-level API)
  - Throws `TrustFlowError` if Freighter is not installed
  - Returns the Freighter instance for direct wallet API access
  
- `isFreighterInstalled()` — Checks whether Freighter browser extension is installed
  - Returns `Promise<boolean>` (async; must be awaited)
  - Useful for conditional UI rendering

- `getAlbedo()` — Gets the Albedo wallet adapter
  - Returns the Albedo instance (does not throw if unavailable; returns null or throws on actual use)

### Types

- `WalletType` — Union of supported types: `'freighter' | 'albedo' | 'xbull' | 'manual'`
- `WalletConnection` — Plain data object representing an active connection:
  ```typescript
  interface WalletConnection {
    type: WalletType;        // The wallet type
    publicKey: string;       // The connected Stellar address
    network: string;         // The network name (e.g., 'TESTNET', 'PUBLIC')
  }
  ```
  Note: This object contains connection state only. To sign, obtain the wallet adapter directly from `getFreighter()` or similar.
  
- `WalletAdapter` — Interface for wallet provider APIs (not returned by `connectWallet`):
  ```typescript
  interface WalletAdapter {
    type: WalletType;
    isAvailable(): Promise<boolean>;
    connect(): Promise<WalletConnection>;
    sign(xdr: string, network: string): Promise<string>;  // Sign an XDR transaction
    disconnect(): Promise<void>;
  }
  ```

### Example

```typescript
import { connectWallet, isFreighterInstalled } from '@trustflow/sdk';

// Check if Freighter is available
const installed = await isFreighterInstalled();
if (!installed) {
  console.log('Freighter not installed');
  return;
}

// Connect to Freighter
try {
  const wallet = await connectWallet('freighter');
  console.log('Connected:', wallet.publicKey);
  console.log('Network:', wallet.network);
  // wallet.publicKey is now available for signing operations
} catch (error) {
  if (error instanceof TrustFlowError && error.code === 'UNAUTHORIZED') {
    console.log('Wallet connection denied');
  }
}
```

## Event Parsing Utilities (`src/events.ts`)

Utilities for parsing raw Soroban contract events into typed TrustFlow event structures.

### Functions

- `isTrustFlowEvent(event, contractId)` — Checks whether a raw event belongs to TrustFlow
  - Validates that `event.contractId` matches the provided `contractId` and `event.type` is 'contract'
  
- `parseEvent(event)` — Parses a single raw Soroban contract event into a typed TrustFlow event
  - Returns `ParsedEvent` or `null` if parsing fails
  - Automatically decodes XDR-encoded values to readable strings
  - Handles multiple event types: `escrow_created`, `escrow_released`, `dispute_raised`, etc.
  
- `parseEvents(events, contractId)` — Parses an array of raw events, filtering and mapping to typed events
  - Filters to only TrustFlow events (via `isTrustFlowEvent`)
  - Maps each through `parseEvent`
  - Returns array of successfully-parsed events

- `fetchContractEvents(server, { contractId, startLedger?, cursor?, limit? })` — `getEvents`-backed fetch helper
  - Applies a contract-ID filter, resumes from `cursor` (or `startLedger`), paginates with `limit`
  - Returns `{ events: RawContractEvent[], nextCursor?, latestLedger? }`
  - Rethrows RPC errors (e.g. cursor older than the retention window) so callers can surface them as gaps

- `createRpcEventFetcher(server, { contractId, startLedger?, limit? })` — builds a `(cursor?) => RawContractEvent[]` fetcher for `EscrowMonitor.startResilientRawPolling`

- `InMemoryCursorStore` — process-lifetime `CursorStore`; implement `CursorStore` (`get()`/`set()`) for durable (file/DB) persistence

### Types

- `TrustFlowEventType` — Union of event type strings: 'escrow_created' | 'escrow_released' | 'escrow_cancelled' | 'dispute_raised' | 'dispute_resolved' | 'milestone_completed'
- `ParsedEvent<T>` — Typed event with `type`, `contractId`, `ledger`, `timestamp`, `id`, `pagingToken`, `data` (`pagingToken` is carried through so parsed events can resume polling)
- `CursorStore`, `FetchContractEventsOptions`, `ContractEventsPage` — resilient subscription primitives
- `EscrowCreatedData`, `EscrowReleasedData`, `DisputeRaisedData` — Event-specific data shapes

### Example

```typescript
import { parseEvents, isTrustFlowEvent } from '@trustflow/sdk';

// Fetch raw events from Horizon
const rawEvents = await horizon.effects().limit(10).call();

// Filter and parse
const trustFlowEvents = parseEvents(
  rawEvents.filter(e => e.type === 'contract'),
  'CBQHN7T6QV7YZXBEHNYQT4ZIXHQ7A4G26QCDHXN46WLZWURVSJR7D4E'
);

trustFlowEvents.forEach(event => {
  if (event.type === 'escrow_created') {
    const { escrowId, sender, recipient, amount } = event.data;
    console.log(`Escrow ${escrowId} created: ${sender} -> ${recipient} (${amount} stroops)`);
  }
});
```

## Validation Schemas
Zod runtime schemas (`src/schemas.ts`) — the same ones the SDK uses internally — exported from
the package root so frontend code can validate form/input data before calling the SDK, without
re-implementing the rules:

- `StellarAddressSchema`, `ContractIdSchema`, `StroopsSchema`, `NetworkSchema` — primitives
- `CreateEscrowSchema`, `ReleaseEscrowSchema`, `DisputeEscrowSchema` — escrow operation inputs
- `ClientConfigSchema` — `new TrustFlowClient(...)` config
- Inferred types `CreateEscrowInput`, `ReleaseEscrowInput`, `DisputeEscrowInput` are exported
  alongside their schemas. (`Network`/`ClientConfig` are not re-exported under those names from
  the root — they'd collide with the existing plain TS types of the same name; derive them
  yourself with `z.infer<typeof ClientConfigSchema>` / `z.infer<typeof NetworkSchema>` if needed.)

```typescript
import { CreateEscrowSchema } from '@trustflow/sdk';

const result = CreateEscrowSchema.safeParse(formValues);
if (!result.success) {
  showFormErrors(result.error.flatten());
}
```

## Retry Behavior

Every network call the SDK makes goes through one policy: **retry transient failures, never
deterministic ones.** See `docs/BROWSER_COMPATIBILITY.md` for browser notes and
[`classifyFailure`](#retry-classification) for the rules.

### Configuration

One `ApiRetryConfig` block configures all of them — Horizon reads, Soroban RPC calls, the
raw-`fetch` helpers, and the backend/IPFS HTTP clients:

```typescript
const client = new TrustFlowClient({
  contractId,
  retry: { retries: 4, retryDelayMs: 500, maxRetryDelayMs: 10_000, jitter: true },
});
```

| Field | Default | Meaning |
|---|---|---|
| `retries` | `3` | Retry attempts **after** the first, so `retries: 0` disables retrying |
| `retryDelayMs` | `250` | Base delay before the first retry |
| `maxRetryDelayMs` | `2000` | Cap on any single delay |
| `jitter` | `true` | Equal jitter — each delay lands in `[delay / 2, delay]` |

The same block is accepted by `DisputeClientOptions`, `ProfileClientOptions`, `IPFSConfig`,
`AuthRequestOptions`, `TrustFlowEscrowClient`'s constructor, and `getGigs(params, options)`.
A `Retry-After` header on a `429` overrides the backoff schedule, still capped by
`maxRetryDelayMs`.

Horizon/Soroban defaults come from `DEFAULT_NODE_RETRY_CONFIG` (2 retries, 300ms base, 5s cap) —
deliberately shorter than the backend default, so a degraded network surfaces quickly instead of
stalling a UI.

### Timeouts

Every network call the SDK makes is bounded by a deadline, so a stalled server surfaces as a
`TIMEOUT` error instead of hanging the caller. The client-wide default is configured once:

```typescript
const client = new TrustFlowClient({
  contractId,
  timeoutMs: 15_000, // default 10s — Horizon + Soroban RPC calls
});
```

| Option | Default | Applies to |
|---|---|---|
| `ClientConfig.timeoutMs` | `10_000` | `connect()`, `getBalance()`, `getAccountInfo()`, and every contract read/simulate/invoke call |
| `ReadContractStateOptions.timeoutMs` / `InvokeContractOptions.timeoutMs` | client-wide | one contract call |
| `RetryPolicy.timeoutMs` (pipeline) | client-wide | each attempt of one pipeline stage |
| `SubmitOptions.pollTimeoutMs` | `pollAttempts` x `pollIntervalMs` | overall confirmation-polling deadline |
| `ContractConfig.timeoutMs` | `10_000` | backend calls made by `TrustFlowEscrowClient` / `DisputeClient` / `MultiSigEscrowClient` |
| `TrustFlowEscrowClientOptions.timeoutMs` / `DisputeClientOptions.timeoutMs` / `MultiSigEscrowClientOptions.timeoutMs` / `AuthRequestOptions.timeoutMs` / `IPFSConfig.timeoutMs` | `10_000` | one backend client or call |

A timed-out attempt is retried like any other transient failure while the retry budget lasts;
once the budget is spent the call fails with a `TIMEOUT` `TrustFlowError` (or a
`Request timed out after <n>ms` message from the backend clients). The Stellar SDK's
`rpc.Server` (v15.x) ignores its `timeout` constructor option, so RPC timeouts are enforced by
racing each call against the deadline; the raw-`fetch` helpers (`fetchAccountInfo`,
`submitTransaction`) abort the in-flight request at the deadline.

### Retry classification

`classifyFailure(error)` returns `{ kind, transient, status?, retryAfterMs?, reason }`, where
`kind` is one of `network | timeout | throttled | server | node-busy | deterministic | unknown`.

| Failure | Retried? |
|---|---|
| Transport error (`ECONNRESET`, DNS, TLS, offline), `fetch` rejection | Yes |
| Timeout (`ETIMEDOUT`, `ECONNABORTED`, `AbortError`) | Yes |
| `408`, `429`, `5xx` | Yes (idempotent methods only — see below) |
| Soroban `TRY_AGAIN_LATER` / `tx_too_early` | Yes |
| Other `4xx` | No |
| `SIMULATION_ERROR` (`Error(Contract, #n)`) | No |
| Node `ERROR` rejection, on-chain `FAILED` | No |
| Confirmation-poll timeout | Yes — the node never rejected the envelope |

An unrecognised error is treated as transient (`kind: 'unknown'`): every retried call site awaits
an HTTP or RPC transport, so a raw `throw` from one is a transport failure unless it carried a
protocol-level signal. `markTransient(error, bool)` overrides the heuristic for call sites that
know better — the pipeline uses it to mark `TRY_AGAIN_LATER` and poll timeouts as retryable while
leaving node rejections terminal.

### Idempotency

Non-idempotent requests are **not** replayed by default. A `POST` on `5xx`, or on a transport
error, is returned to the caller, because the server may have processed the request before the
response was lost — so `DisputeClient.raiseDispute`, `IPFSStorage.upload` and
`verifyAndGetToken` are never retried. Opt a specific call in when replaying is safe:

```typescript
await http.post('/disputes', payload, { trustflowRetry: true });
```

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are retried. `submitTransaction` is a `POST`, so it
retries only the genuinely ambiguous cases (transport error, `408`, `429`, `5xx`) and never a
Horizon response carrying result codes; the replayed envelope is byte-identical, so a retry cannot
double-spend.

### Pipeline errors

`TransactionPipeline` returns the **specific** error for a terminal failure, and reserves
`RETRY_EXHAUSTED` for a stage that really was retried and really did run out of budget (with the
last error as `cause`):

```typescript
const result = await pipeline.run(params);
if (!result.ok) {
  switch (result.error.code) {
    case 'SIMULATION_ERROR': /* the contract rejected the call; do not retry */ break;
    case 'SUBMISSION_ERROR': /* node ERROR or on-chain FAILED */ break;
    case 'RETRY_EXHAUSTED':  /* transient failures exhausted the budget */ break;
  }
}
```

### Generic helper

```typescript
import { retry, cappedExponentialBackoff, isTransientError } from '@trustflow/sdk';

await retry(attempt => doWork(attempt), {
  attempts: 4,
  delayMs: cappedExponentialBackoff(300, 5_000),
  shouldRetry: isTransientError,   // omit to retry every failure (the default)
  jitter: true,
  onRetry: (attempt, error, info) => log(attempt, error, info),
});
```

## TransactionPipeline
Unified pipeline for assembling, simulating, fee-adjusting, fee-bumping, and retrying
Soroban transactions against RPC. Every method returns a `PipelineResult<T>`
(`{ ok: true; data: T } | { ok: false; error: TrustFlowError }`) instead of throwing, so
callers get a typed, actionable `error.code` (e.g. `ASSEMBLY_ERROR`, `SIMULATION_ERROR`,
`FEE_BUMP_ERROR`, `SUBMISSION_ERROR`, `RETRY_EXHAUSTED`) without try/catch.

- `new TransactionPipeline(client: TrustFlowClient)`
- `.assemble(params)` — builds an unsigned transaction from a source account and operations
- `.simulate(tx)` — simulates a transaction against Soroban RPC without mutating it
- `.prepare(tx, options?)` — simulates and folds the footprint/auth/resource fee back onto
  the transaction, applying a configurable safety multiplier (`resourceFeeMultiplier`,
  default 1.1) on top of the RPC-reported `minResourceFee`; retries transient RPC failures
  with exponential backoff
- `.buildFeeBump(innerTx, { feeSource, baseFee? })` — wraps a transaction in a fee-bump
  envelope
- `.submit(tx, options?)` — broadcasts a signed transaction and polls for confirmation,
  retrying transient submission failures with exponential backoff. Set
  `submit.feeBump.maxFeeBump` with `feeSource` to automatically wrap a signed inner
  transaction in progressively higher fee-bump envelopes when confirmation polling times
  out. Each step reads the latest Soroban RPC p90 inclusion fee and multiplies the previous
  base fee (default multiplier: 2); `onFeeBump` receives the old/new hashes and fee details.
- `.run(params)` — convenience method chaining assemble → prepare → sign → submit; when
  submission fails for a fee-related reason (`TRY_AGAIN_LATER`, insufficient fee) and
  `submit.feeBump` is configured, automatically builds, signs, and resubmits a fee-bump
  transaction before giving up

```typescript
import { TransactionPipeline, TrustFlowClient } from '@trustflow/sdk';

const client = new TrustFlowClient({ contractId, network: 'TESTNET' });
const pipeline = new TransactionPipeline(client);

const result = await pipeline.run({
  sourceAccount: sender.publicKey(),
  operations: [contract.call('release', ...args)],
  signers: [sender],
  submit: {
    feeBump: {
      feeSource: sponsor,
      maxFeeBump: 3,
      onFeeBump: ({ hash, baseFee, attempt }) => {
        console.info(`Fee bump ${attempt}: ${hash} at ${baseFee} stroops`);
      },
    },
  },
});

if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  console.log('confirmed:', result.data.hash, 'feeBumped:', result.data.feeBumped);
}
```

## Error Handling

The SDK uses three error handling patterns depending on the API layer:

### Error Pattern Overview

| Pattern | APIs | Return Type | When It Throws |
|---------|------|-------------|-----------------|
| **Throws TrustFlowError** | Function-style (createEscrow, releaseEscrow), wallet functions, auth functions, TrustFlowClient.connect() | N/A | On any validation or network failure |
| **Returns SDKResult<T>** | TrustFlowEscrowClient methods (createEscrow, fund, release), DisputeClient, ProfileClient, JurorClient | `{ ok: true; data: T }` or `{ ok: false; error: string }` | Never (errors are wrapped in result) |
| **Returns PipelineResult<T>** | TransactionPipeline methods (assemble, simulate, prepare, buildFeeBump, submit, run) | `{ ok: true; data: T }` or `{ ok: false; error: TrustFlowError }` | Never (errors include typed code and cause) |

### Throws TrustFlowError
Used by function-style APIs and initialization. Suitable for scripts and one-off operations:

```typescript
import { TrustFlowClient, TrustFlowError, createEscrow } from '@trustflow/sdk';

try {
  const client = new TrustFlowClient({ contractId: '' });
} catch (error) {
  if (error instanceof TrustFlowError) {
    console.error(`Error [${error.code}]: ${error.message}`);
  }
}

try {
  const escrow = await createEscrow(client, {
    sender: 'GSENDER...',
    recipient: 'GRECIPIENT...',
    amountStroops: 100_000_000n,
    durationBlocks: 1000,
  });
} catch (error) {
  if (error instanceof TrustFlowError && error.code === 'VALIDATION_ERROR') {
    console.log('Invalid input:', error.message);
  }
}
```

### Returns SDKResult<T>
Used by class-based high-level clients (TrustFlowEscrowClient, DisputeClient, etc.):

```typescript
const escrowClient = new TrustFlowEscrowClient(config);
const result = await escrowClient.createEscrow(params);

if (result.ok) {
  console.log('Created escrow:', result.data.escrowId);
} else {
  console.log('Failed:', result.error); // error is a string, not an error code
}
```

Note: Errors are strings, not error codes, so you cannot branch on error type.

### Returns PipelineResult<T>
Used by TransactionPipeline for multi-stage operations with typed error codes:

```typescript
const pipeline = new TransactionPipeline(client);
const result = await pipeline.run({
  sourceAccount: senderPublicKey,
  operations: [contract.call('release', ...args)],
  signers: [senderKeypair],
  submit: { feeBump: { feeSource: sponsorKeypair } },
});

if (!result.ok) {
  console.error(`[${result.error.code}]: ${result.error.message}`);
  if (result.error.code === 'SUBMISSION_ERROR') {
    // Retry or escalate
  } else if (result.error.code === 'FEE_BUMP_ERROR') {
    // Handle fee-bump failure
  }
} else {
  console.log('confirmed:', result.data.hash, 'feeBumped:', result.data.feeBumped);
}
```

### TrustFlowError & TrustFlowErrorCode

Both `TrustFlowError` and its `TrustFlowErrorCode` type union are exported from the package root:

```typescript
import { TrustFlowClient, TrustFlowError, type TrustFlowErrorCode } from '@trustflow/sdk';

// Thrown by function-style and initialization APIs
try {
  const client = new TrustFlowClient({ contractId: '' });
} catch (error) {
  if (error instanceof TrustFlowError) {
    console.error(`TrustFlow error [${error.code}]: ${error.message}`);
  }
}

// Returned (in error.error) by TransactionPipeline
const result = await pipeline.run(...);
if (!result.ok) {
  // result.error is a TrustFlowError instance with .code and .cause
  console.error(result.error.code, result.error.message, result.error.cause);
}
```

### Error Codes (`TrustFlowErrorCode`) Matrix

The SDK uses `TrustFlowErrorCode` to classify all failure modes. Each error instance provides an actionable `.code`, optional `.field` and `.issues` for validation details, and an underlying `.cause`.

| Error Code | Category | Produced By | Common Root Cause | Recommended Recovery Strategy |
|---|---|---|---|---|
| `CONNECTION_ERROR` | Transient | HTTP client, Auth API, Soroban RPC | Network partition, DNS resolution failure, unreachable node | Retry with exponential backoff; switch to fallback RPC URL |
| `CONTRACT_ERROR` | Fatal | Contract invocation | Contract panicked, reverted, or hit host error during execution | Inspect error logs and contract state; do not blindly retry |
| `INVALID_CONTRACT_CALL` | Fatal | SorobanSpec parser/encoder, contract builders | Method missing in spec, invalid argument count, wrong argument types | Verify contract ABI spec; fix method name or argument shape |
| `VALIDATION_ERROR` | Fatal | EscrowBuilder, validation utils, client methods | Invalid Stellar address, negative amount, malformed hex/base64 | Check `error.field`; sanitize user input before resubmitting |
| `UNAUTHORIZED` | Actionable | Wallet connectors, auth verification, disputes | User denied permissions, invalid token, or unauthorized caller | Prompt user to re-authenticate or connect authorized wallet |
| `NOT_FOUND` | Informational | Escrow queries, resource lookups | Escrow ID, account, or requested state does not exist | Verify resource identifier; ensure transaction has confirmed |
| `SIMULATION_ERROR` | Fatal / Actionable | TransactionPipeline.simulate, readContractState | Soroban simulation failed, contract trap, or restore required | If `needsRestore`, restore expired state; else fix preconditions |
| `SIGNING_ERROR` | Actionable | Transaction signing, wallet adapters | Wallet popup cancelled, hardware wallet error, invalid keypair | Prompt user to unlock wallet or reconnect signing device |
| `INVALID_CONFIG` | Fatal | TrustFlowClient / EscrowClient constructors | Missing `contractId`, invalid RPC URL, mismatched passphrase | Fix initialization options in code or environment variables |
| `NOT_CONNECTED` | Actionable | Client methods before connect() | Operation attempted before client connected to wallet/node | Call `client.connect()` or specify an active account |
| `BALANCE_FETCH_ERROR` | Transient / Actionable | TrustFlowClient.getBalance() | Horizon unreachable or account not yet funded on ledger | Fund account via Friendbot if new; retry if network failed |
| `MULTISIG_ERROR` | Actionable | MultiSigEscrowClient | Multi-signature workflow state mismatch or corrupted data | Inspect multi-sig operation state and signature collection |
| `MULTISIG_THRESHOLD_NOT_MET` | Actionable | MultiSigEscrowClient | Signatures collected is less than required signing threshold | Collect remaining authorized signatures before submission |
| `MULTISIG_ALREADY_SIGNED` | Informational | MultiSigEscrowClient | Current signer has already submitted a signature | Skip redundant signing; proceed to next authorized signer |
| `MULTISIG_EXPIRED` | Fatal | MultiSigEscrowClient | Multi-sig operation TTL or deadline expired before completion | Discard expired operation; initiate a fresh multi-sig proposal |
| `MULTISIG_INVALID_SIGNER` | Fatal | MultiSig signature verification | Signer address is not an authorized participant in multi-sig group | Verify account belongs to authorized multi-sig participant list |
| `MULTISIG_XDR_ERROR` | Fatal | MultiSig serialization | Malformed transaction envelope XDR or version mismatch | Verify XDR string encoding and matching network passphrase |
| `ASSEMBLY_ERROR` | Transient / Fatal | TransactionPipeline.assemble | Sequence number lookup failed or builder rejected operation | Refresh account sequence from network and rebuild transaction |
| `FEE_BUMP_ERROR` | Actionable | TransactionPipeline.buildFeeBump | Base fee lower than inner transaction fee, or invalid fee signer | Increase fee-bump budget; ensure fee source has sufficient funds |
| `SUBMISSION_ERROR` | Transient / Fatal | TransactionPipeline.submit, Soroban RPC | Node mempool rejected tx (`txBAD_SEQ`, `txINSUFFICIENT_FEE`) | If `txBAD_SEQ`, refresh sequence; if fee error, bump fee |
| `RETRY_EXHAUSTED` | Transient Limit | TransactionPipeline, retry decorators | All retry attempts spent without operation succeeding | Check upstream service status; consider increasing retry budget |
| `NETWORK_ERROR` | Transient | Axios HTTP requests, RPC transports | Socket reset, gateway 502/503/504, dropped connection | Retry idempotent requests with capped exponential backoff |
| `AUTH_ERROR` | Actionable | Challenge generation/verification, crypto | Random generator unavailable, invalid signature, expired token | Re-fetch fresh auth challenge and prompt user to re-sign |
| `TIMEOUT` | Transient | HTTP calls, simulation deadline, confirmation poll | Request exceeded `timeoutMs` or tx did not land in time | Check transaction status by hash before resubmitting |
| `CIRCUIT_BREAKER_OPEN` | Transient | CircuitBreaker utility | Consecutive failure threshold exceeded; requests fast-failed | Await cooldown period (half-open state) before sending requests |
| `ACCOUNT_NOT_FOUND` | Actionable | AccountsManager, TrustFlowClient | Named account context not registered or account unfunded | Call `client.accounts.add()` or fund account with native asset |
| `UNSUPPORTED_ENVIRONMENT` | Fatal | Environment detector | Missing WebCrypto or Node.js crypto primitives in runtime | Upgrade Node.js (>=20) or include WebCrypto polyfills |
| `VERSION_MISMATCH` | Fatal | Version negotiator | Client SDK version is incompatible with backend API version | Update `@trustflow/sdk` or align backend deployment version |
| `USER_REJECTED` | Actionable | Wallet connectors (Freighter, Albedo, xBull) | User dismissed wallet popup or declined connection/signing | Gracefully prompt user to re-open wallet when ready |
| `STALE_CHALLENGE` | Transient / Actionable | Challenge validator | Auth challenge nonce expired before signature verification | Request a fresh challenge and verify immediately |

---

### Handling Transient vs Fatal Errors

Use the error category to decide whether to retry automatically or alert the user:

```typescript
import { TrustFlowError, type TrustFlowErrorCode } from '@trustflow/sdk';

const TRANSIENT_CODES: ReadonlySet<TrustFlowErrorCode> = new Set([
  'CONNECTION_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CIRCUIT_BREAKER_OPEN',
  'RETRY_EXHAUSTED',
]);

async function executeWithRecovery<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt++;

      if (error instanceof TrustFlowError) {
        // 1. Transient errors: Retry with exponential backoff and jitter
        if (TRANSIENT_CODES.has(error.code) && attempt < maxRetries) {
          const delayMs = Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 200, 5000);
          console.warn(`[${error.code}] Transient failure on attempt ${attempt}. Retrying in ${delayMs.toFixed(0)}ms...`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        // 2. Actionable user errors: Guide user remediation
        if (error.code === 'USER_REJECTED') {
          throw new Error('Connection cancelled. Please approve the wallet request to continue.');
        }
        if (error.code === 'VALIDATION_ERROR') {
          throw new Error(`Invalid form field "${error.field}": ${error.message}`);
        }
        if (error.code === 'UNAUTHORIZED') {
          throw new Error('Session expired or permissions insufficient. Please log in again.');
        }

        // 3. Fatal errors: Stop execution and log diagnosis
        console.error(`Fatal TrustFlowError [${error.code}]:`, error.message, error.cause);
        throw error;
      }

      // Non-SDK unexpected errors
      throw error;
    }
  }
}
```

---

### Static Factory Methods

Create pre-formatted errors:

- `TrustFlowError.wrap(error: unknown, code?: TrustFlowErrorCode)` — Wrap any unknown error into a typed `TrustFlowError`
- `TrustFlowError.notFound(resource: string)` — 'NOT_FOUND' error
- `TrustFlowError.unauthorized(action: string)` — 'UNAUTHORIZED' error
- `TrustFlowError.validation(field: string, message: string, issues?: any[])` — 'VALIDATION_ERROR' with field name
- `TrustFlowError.userRejected(detail?: string, cause?: unknown)` — 'USER_REJECTED' error
- `TrustFlowError.versionMismatch(clientVersion: string, serverVersion: string, details?: string)` — 'VERSION_MISMATCH' error
- `TrustFlowError.timedOut(timeoutMs: number, context?: string)` — 'TIMEOUT' error with context
- `TrustFlowError.queueTimeout(timeoutMs: number)` — 'TIMEOUT' for transaction serialization queue
- `TrustFlowError.accountNotFound(ref?: string)` — 'ACCOUNT_NOT_FOUND' error
- `TrustFlowError.multiSigThresholdNotMet(collected: number, required: number)` — 'MULTISIG_THRESHOLD_NOT_MET' error
- `TrustFlowError.multiSigExpired(operationId: string)` — 'MULTISIG_EXPIRED' error
- `TrustFlowError.multiSigInvalidSigner(address: string)` — 'MULTISIG_INVALID_SIGNER' error
- `TrustFlowError.multiSigXdrError(detail: string)` — 'MULTISIG_XDR_ERROR' error
- `TrustFlowError.assemblyFailed(detail: string, cause?: unknown)` — 'ASSEMBLY_ERROR' error
- `TrustFlowError.simulationFailed(detail: string, cause?: unknown)` — 'SIMULATION_ERROR' error
- `TrustFlowError.feeBumpFailed(detail: string, cause?: unknown)` — 'FEE_BUMP_ERROR' error
- `TrustFlowError.submissionFailed(detail: string, cause?: unknown)` — 'SUBMISSION_ERROR' error
- `TrustFlowError.signingFailed(detail: string, cause?: unknown)` — 'SIGNING_ERROR' error
- `TrustFlowError.retryExhausted(stage: string, attempts: number, cause?: unknown)` — 'RETRY_EXHAUSTED' error


## Testing Kit (`@trustflow/sdk/testing`)

Import offline test doubles and helpers:

```typescript
import {
  createMockHorizonServer,
  createMockSorobanServer,
  MockWalletAdapter,
  buildMockEscrow,
  buildMockEscrowState,
  buildMockContractEvent,
  isValidScVal,
  toBeValidScVal,
} from @trustflow/sdk/testing;
```

See [docs/TESTING.md](./TESTING.md) for full usage examples.

## Gig Search & Filter Options

`client.getGigs(params)` supports the following query filters:
- `cursor` — Pagination cursor
- `limit` — Maximum items per page (positive integer <= 100)
- `status` — Filter by escrow status
- `depositor` — Filter by depositor Stellar address
- `beneficiary` — Filter by beneficiary Stellar address
- `tokenAddress` — Filter by custom token address
- `createdAfter` / `createdBefore` — Filter by ISO date string or Date object
- `minAmount` / `maxAmount` — Filter by amount bounds
- `sortBy` — Sort field (`created_at`, `amount`, `deadline`, `status`)
- `sortOrder` — Sort direction (`asc`, `desc`)
