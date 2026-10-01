import { negotiateApiVersion } from './utils/version';
import { Config, Horizon, rpc, xdr } from '@stellar/stellar-sdk';
import {
  HORIZON_URLS,
  SOROBAN_RPC_URLS,
  NETWORK_PASSPHRASES,
  DEFAULT_NETWORK,
  SDK_VERSION,
  DEFAULT_API_VERSION,
} from './constants';
import { logger, SDKLogger } from './utils/logger';
import { TrustFlowError } from './errors';
import type { Network, ClientConfig, LoggingConfig } from './types';
import { IPFSStorage } from './storage';
import { SimpleCache } from './utils/cache';
import { AccountManager } from './accounts/manager';
import type { AccountContext, AccountOptions, AddAccountInput } from './accounts/types';
import { assertStellarAddress } from './utils/validation';
import { fetchAccountInfo, type AccountInfo } from './stellar/account';
import { NETWORK_CONFIGS } from './stellar/network';
import { withTransientRetry } from './utils/node-retry';
import {
  assertWebCryptoSupport,
  detectFeatures,
  type EnvironmentReport,
} from './utils/environment';
import { clearSession, loadSession, saveSession, type Session } from './auth/session';
import type { ApiRetryConfig } from './utils/http';

/** Default TTL for opt-in Horizon balance caching. */
export const DEFAULT_BALANCE_CACHE_TTL_MS = 5_000;

/** Controls cache behavior for a single balance lookup. */
export interface GetBalanceOptions {
  /** Fetch from Horizon even when a non-expired cached balance is available. */
  skipCache?: boolean;
  /** Account id or `G...` address whose cache entry to read/write. Defaults to the active account. */
  account?: string;
}
import { createContractBinding, SorobanContractClient } from './contract';

/** Pre-populates {@link TrustFlowClient.accounts} from the constructor config. */
export interface MultiAccountConfig {
  /** Accounts to register up front. The first becomes active. */
  accounts: AddAccountInput[];
}

/**
 * TrustFlowClient is the main entry point for interacting with the TrustFlow Protocol.
 * It handles network configuration, RPC connections, and provides access to escrow operations.
 *
 * ## Multiple accounts
 *
 * One client can act as many accounts. Register them on
 * {@link TrustFlowClient.accounts} and switch with
 * {@link TrustFlowClient.useAccount} — a field write, not a re-initialisation:
 * the Horizon server, the Soroban RPC server, the retry budget and the IPFS
 * helper are all shared and stay warm.
 *
 * Every account-scoped method takes an optional `account`, so a single call
 * can target an account other than the active one. Per-account state (session
 * token, balance cache entry, `data` bag) is namespaced by account id, so
 * switching can never leak one account's session or credentials into another's
 * request.
 *
 * With no accounts registered the client behaves exactly as it always has —
 * single account, no context, no extra errors — so existing integrations need
 * no changes.
 *
 * @example
 * ```typescript
 * const client = new TrustFlowClient({ contractId, accounts: [
 *   { address: alice, label: 'Alice', roles: ['depositor'] },
 *   { address: bob,   label: 'Bob',   roles: ['beneficiary'] },
 * ] });
 *
 * client.useAccount(bob);                  // switch — no reconnect
 * await client.getAccountInfo();           // Bob's balance/sequence
 * await client.getAccountInfo({ account: alice });  // Alice, active unchanged
 * ```
 */
export class TrustFlowClient {
  private server: Horizon.Server;
  private sorobanServer?: rpc.Server;
  private readonly balanceCache?: SimpleCache<string, string>;
  private _connected: boolean = false;
  private readonly logger: SDKLogger;

  private _network!: Network;
  get network(): Network { return this._network; }
  readonly contractId: string;
  private _rpcUrl!: string;
  get rpcUrl(): string { return this._rpcUrl; }
  private _horizonUrl!: string;
  get horizonUrl(): string { return this._horizonUrl; }
  private _networkPassphrase!: string;
  get networkPassphrase(): string { return this._networkPassphrase; }
  readonly apiBaseUrl?: string;
  readonly apiKey?: string;
  readonly version: string = SDK_VERSION;
  readonly apiVersion: string;
  /**
   * Default per-request timeout for Horizon and Soroban RPC calls. Every
   * per-call timeout option overrides it; see {@link ClientConfig.timeoutMs}.
   */
  readonly timeoutMs?: number;
  /** IPFS upload helper — `client.storage.upload(file)`. */
  readonly storage: IPFSStorage;
  /** Every account this client can act as. See {@link TrustFlowClient.useAccount}. */
  readonly accounts: AccountManager;
  /**
   * Retry budget applied to every Horizon / Soroban RPC call. Reused as-is for
   * the backend and IPFS HTTP helpers, so one block configures the whole client.
   */
  readonly retryConfig?: ApiRetryConfig;

  /**
   * Creates a new TrustFlow client instance.
   *
   * @param config - Client configuration options
   * @param config.contractId - The Soroban contract ID for TrustFlow escrow
    * @param config.network - Target network, defaults to TESTNET
   * @param config.rpcUrl - Optional custom Soroban RPC URL
   * @param config.apiBaseUrl - Optional TrustFlow API base URL for backend integration
   * @param config.apiKey - Optional API key for authenticated requests
   * @param config.ipfs - Optional configuration for the built-in `storage.upload()` IPFS helper
   * @param config.retry - Optional retry budget for every network call (see {@link ClientConfig.retry})
   * @param config.timeoutMs - Optional per-request timeout for Horizon and Soroban RPC calls (see {@link ClientConfig.timeoutMs})
   * @param config.accounts - Optional account contexts to register up front
   *
   * @example
   * ```typescript
   * const client = new TrustFlowClient({
   *   contractId: process.env.CONTRACT_ID!,
   *   network: 'TESTNET',
   *   apiBaseUrl: 'https://api.trustflow.xyz',
   *   apiKey: process.env.API_KEY,
   *   logging: { level: 'debug' }
   * });
   * await client.connect();
   *
   * const upload = await client.storage.upload(fileBuffer, { filename: 'contract.pdf' });
   * if (upload.ok) console.log('Uploaded:', upload.data.url);
   * ```
   */
  constructor(config: ClientConfig) {
    if (!config.contractId) {
      throw new TrustFlowError('contractId is required', 'INVALID_CONFIG');
    }

    if (config.rpcUrl) {
      try {
        new URL(config.rpcUrl);
      } catch {
        throw new TrustFlowError(`Invalid rpcUrl: "${config.rpcUrl}"`, 'INVALID_CONFIG');
      }
    }

    if (config.horizonUrl) {
      try {
        new URL(config.horizonUrl);
      } catch {
        throw new TrustFlowError(`Invalid horizonUrl: "${config.horizonUrl}"`, 'INVALID_CONFIG');
      }
    }

    this._network = config.network ?? DEFAULT_NETWORK;
    if (!NETWORK_CONFIGS[this._network]) {
      throw new TrustFlowError(`Unsupported network: ${String(this._network)}`, 'INVALID_CONFIG');
    }
    this.contractId = config.contractId;
    this._rpcUrl = config.rpcUrl ?? SOROBAN_RPC_URLS[this.network];
    this._horizonUrl = config.horizonUrl ?? HORIZON_URLS[this.network];
    this._networkPassphrase = config.networkPassphrase ?? NETWORK_PASSPHRASES[this.network];
    if (typeof this._networkPassphrase !== 'string' || !this._networkPassphrase.trim()) {
      throw new TrustFlowError('networkPassphrase must not be empty', 'INVALID_CONFIG');
    }
    this.apiBaseUrl = config.apiBaseUrl;
    this.apiKey = config.apiKey;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = config.timeoutMs;
    this.retryConfig = config.ipfs ? { ...config.retry, ...config.ipfs.retry } : config.retry;
    this.storage = new IPFSStorage(config.ipfs);
    this.balanceCache = config.balanceCache
      ? new SimpleCache(config.balanceCache.ttlMs ?? DEFAULT_BALANCE_CACHE_TTL_MS)
      : undefined;

    this.server = config.horizonServer ?? new Horizon.Server(this.horizonUrl);
    this.sorobanServer = config.rpcServer;
    this.logger = logger;
    this.accounts = new AccountManager();
    for (const account of config.accounts ?? []) {
      this.accounts.add(account);
    }

    // Initialize logger from config
    this.logger = this.createLogger(config.logging);
  }

  private createLogger(logging?: LoggingConfig): SDKLogger {
    if (logging?.logger) {
      // Wrap custom logger in SDKLogger interface
      const customLogger = logging.logger;
      return new SDKLogger({
        minLevel: 'silent',
        logger: {
          debug: (msg, ctx) => customLogger.debug(msg, ctx),
          info: (msg, ctx) => customLogger.info(msg, ctx),
          warn: (msg, ctx) => customLogger.warn(msg, ctx),
          error: (msg, ctx) => customLogger.error(msg, ctx),
        },
      });
    }
    return new SDKLogger({
      minLevel: logging?.level ?? 'error',
      json: logging?.json,
      prefix: 'TrustFlowClient',
    });
  }

  /** Get the internal logger instance */
  getLogger(): SDKLogger {
    return this.logger;
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  /**
   * Registers an account this client can act as. The first registered account
   * becomes active automatically.
   *
   * @param input - Address plus optional id, label, API key, roles and data
   * @returns The stored account context
   * @throws {TrustFlowError} `VALIDATION_ERROR` for a missing or malformed address
   *
   * @example
   * ```typescript
   * client.accounts.add({ address: carol, label: 'Carol', roles: ['arbitrator'] });
   * ```
   */
  addAccount(input: AddAccountInput): AccountContext {
    return this.accounts.add(input);
  }

  /**
   * The active account, or `null` when none is registered.
   *
   * @example
   * ```typescript
   * client.activeAccount?.address;
   * ```
   */
  get activeAccount(): AccountContext | null {
    return this.accounts.active;
  }

  /**
   * Switches the active account. Cheap and synchronous: no client is rebuilt,
   * no Horizon or Soroban connection is reopened, and no other account's state
   * is touched.
   *
   * @param ref - Account id or `G...` address
   * @returns The now-active account context
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when `ref` is not registered
   *
   * @example
   * ```typescript
   * client.useAccount('G…BOB…');
   * const mine = await client.getAccountInfo();
   * ```
   */
  useAccount(ref: string): AccountContext {
    return this.accounts.activate(ref);
  }

  /**
   * Runs `fn` with `ref` active, then restores the previous active account —
   * even if `fn` throws. Use it to scope a block of calls to one account
   * without disturbing the app's current selection.
   *
   * @param ref - Account id or `G...` address
   * @param fn - Callback invoked while `ref` is active
   * @returns Whatever `fn` resolves to
   *
   * @example
   * ```typescript
   * const bobView = await client.asAccount(bob, async () => ({
   *   session: client.getSession(),
   *   balance: await client.getAccountInfo(),
   * }));
   * // `client.activeAccount` is unchanged here
   * ```
   */
  async asAccount<T>(ref: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.accounts.activeId;
    this.useAccount(ref);
    try {
      return await fn();
    } finally {
      if (previous !== null) this.accounts.activate(previous);
      else this.accounts.deactivate();
    }
  }

  /**
   * Resolves the account a call should act as.
   *
   * Returns `null` — not an error — when `account` was omitted and no account
   * is active, which is the pre-multi-account single-account case every
   * existing integration is in. Throws only when a caller names an account
   * that is not registered, because that is always a caller bug.
   *
   * @param account - Account id or `G...` address
   * @returns The account context, or `null`
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when `account` is unknown
   * @internal
   */
  resolveAccount(account?: string): AccountContext | null {
    if (account !== undefined) {
      const context = this.accounts.get(account);
      if (!context) throw TrustFlowError.accountNotFound(account);
      return this.accounts.touch(context.id);
    }
    const active = this.accounts.active;
    return active ? this.accounts.touch(active.id) : null;
  }

  /**
   * Subscribes to account registration, update, removal and activation.
   *
   * @param listener - Called synchronously after each change
   * @returns An unsubscribe function
   * @see {@link TrustFlowClient.accounts}
   */
  onAccountChange(listener: Parameters<AccountManager['onChange']>[0]): () => void {
    return this.accounts.onChange(listener);
  }

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------

  /**
   * Reports which browser/Node capabilities are present, and whether the SDK's
   * baseline requirements are met. Never throws and never installs a polyfill.
   *
   * @example
   * ```typescript
   * const report = client.getEnvironment();
   * if (!report.supported) {
   *   console.error(report.missing.map((f) => f.reason));
   * }
   * ```
   */
  getEnvironment(): EnvironmentReport {
    return detectFeatures();
  }

  /**
   * Verifies the runtime can perform WebCrypto operations, throwing an
   * `UNSUPPORTED_ENVIRONMENT` error that names the missing API when it cannot.
   *
   * @param feature - Human-readable name of the operation being attempted
   * @throws {TrustFlowError} `UNSUPPORTED_ENVIRONMENT` when WebCrypto is absent
   */
  assertCryptoSupport(feature?: string): void {
    assertWebCryptoSupport(feature);
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /**
   * Establishes connection to the Stellar network and verifies connectivity.
   * Must be called before performing any network operations.
   *
   * Transient Horizon failures (connection reset, timeout, `429`, `5xx`) are
   * retried with capped exponential backoff and jitter; anything else fails
   * immediately.
   *
   * @throws {TrustFlowError} `CONNECTION_ERROR` if connection to the network fails
   *
   * @example
   * ```typescript
   * await client.connect();
   * console.log('Connected to', client.network);
   * ```
   */
  async connect(): Promise<void> {
    this.logger.debug('Connecting to Stellar network', { network: this.network, rpcUrl: this.rpcUrl });
    try {
      // Test connection by fetching ledger info
      await withTransientRetry(
        () => this.getServer().ledgers().limit(1).call(),
        { timeoutMs: this.timeoutMs },
        this.retryConfig,
        'horizon.ledgers',
      );
      const health = await withTransientRetry(
        () => this.getSorobanServer().getHealth(),
        { timeoutMs: this.timeoutMs },
        this.retryConfig,
        'soroban.health',
      );
      if (health.status !== 'healthy') {
        throw new Error(`Soroban RPC is not healthy: ${health.status}`);
      }
      this._connected = true;
      this.logger.info('Connected to Stellar network', { network: this.network });
    } catch (error) {
      this._connected = false;
      this.logger.error('Failed to connect to Stellar network', { network: this.network, error });
      // A timeout is its own diagnosis — keep the `TIMEOUT` code instead of
      // burying it under a generic connection failure.
      if (error instanceof TrustFlowError && error.code === 'TIMEOUT') throw error;
      throw new TrustFlowError('Failed to connect to Stellar network', 'CONNECTION_ERROR', error);
    }
  }

  /**
   * Checks if the client is currently connected to the network.
   *
   * @returns true if connected, false otherwise
   */
  isConnected(): boolean {
    return this._connected;
  }

  /** Switches this client to a preset network and invalidates its connections. */
  switchNetwork(network: Network): void {
    const config = NETWORK_CONFIGS[network];
    if (!config) {
      throw new TrustFlowError(`Unsupported network: ${String(network)}`, 'INVALID_CONFIG');
    }
    this._network = network;
    this._rpcUrl = config.rpcUrl;
    this._horizonUrl = config.horizonUrl;
    this._networkPassphrase = config.passphrase;
    this.server = new Horizon.Server(this.horizonUrl);
    this.sorobanServer = undefined;
    this._connected = false;
  }

  async verifyApiCompatibility(): Promise<{ compatible: boolean; serverVersion: string; clientVersion: string }> {
    if (!this.apiBaseUrl) {
      return { compatible: true, serverVersion: 'N/A', clientVersion: this.apiVersion };
    }
    const result = await negotiateApiVersion(this.apiBaseUrl, { clientVersion: this.apiVersion });
    return {
      compatible: result.compatible,
      serverVersion: result.serverVersion,
      clientVersion: result.clientVersion,
    };
  }

  // ---------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the native XLM balance for a given Stellar address.
   *
   * Retries transient Horizon failures with capped, jittered backoff; `4xx`
   * fails immediately.
   *
   * @param address - Stellar public key (G... address)
   * @param options - Set `skipCache` to bypass a configured balance cache, and
   *   `account` to read/write a specific account's cache entry
   * @returns Balance in XLM as a string
   * @throws {TrustFlowError} If the account doesn't exist or network error occurs
   *
   * @example
   * ```typescript
   * const balance = await client.getBalance('GDEPOSITOR...');
   * console.log(`Balance: ${balance} XLM`);
   *
   * // When `balanceCache` is configured, force a fresh Horizon lookup:
   * const freshBalance = await client.getBalance('GDEPOSITOR...', { skipCache: true });
   * ```
   */
  async getBalance(address: string, options: GetBalanceOptions = {}): Promise<string> {
    assertStellarAddress(address, 'address');
    const cacheKey = this.balanceCacheKey(address, options.account);
    if (!options.skipCache) {
      const cachedBalance = this.balanceCache?.get(cacheKey);
      if (cachedBalance !== undefined) return cachedBalance;
    }

    try {
      const account = await withTransientRetry(
        () => this.getServer().loadAccount(address),
        { timeoutMs: this.timeoutMs },
        this.retryConfig,
        'horizon.loadAccount',
      );
      const native = account.balances.find(
        (b: { asset_type: string }) => b.asset_type === 'native',
      );
      const balance = native?.balance ?? '0';
      this.balanceCache?.set(cacheKey, balance);
      return balance;
    } catch (error) {
      // Keep a timeout distinguishable from a balance-fetch failure.
      if (error instanceof TrustFlowError && error.code === 'TIMEOUT') throw error;
      throw new TrustFlowError(
        `Failed to fetch balance for ${address}`,
        'BALANCE_FETCH_ERROR',
        error,
      );
    }
  }

  /**
   * Fetches the active (or named) account's own on-chain state.
   *
   * Unlike {@link TrustFlowClient.getBalance}, a transient Horizon outage is
   * retried and — if it persists — **throws**. It is never reported as
   * `isActive: false`, which would make a network blip indistinguishable from
   * an account that has genuinely never been funded.
   *
   * @param options - `account` to target a specific account; defaults to active
   * @returns The account's balance, sequence number and activation state
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when no account is resolved,
   *   or `CONNECTION_ERROR` when Horizon stays unreachable
   *
   * @example
   * ```typescript
   * const me = await client.getAccountInfo();
   * if (!me.isActive) console.log('fund this account first');
   * ```
   */
  async getAccountInfo(options: AccountOptions = {}): Promise<AccountInfo> {
    const account = this.accounts.require(options.account);
    try {
      return await withTransientRetry(
        () => fetchAccountInfo(account.address, this.network, this.retryConfig, this.horizonUrl, this.timeoutMs),
        undefined,
        this.retryConfig,
        'horizon.accountInfo',
      );
    } catch (error) {
      // A timed-out fetch keeps its `TIMEOUT` code rather than masquerading
      // as a generic connection failure.
      if (error instanceof TrustFlowError && error.code === 'TIMEOUT') throw error;
      throw new TrustFlowError(
        `Failed to fetch account info for ${account.address}`,
        'CONNECTION_ERROR',
        error,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions (per account)
  // ---------------------------------------------------------------------------

  /**
   * Returns the stored backend session for an account, or `null`.
   *
   * Sessions are namespaced by account id, so two accounts signed in on the
   * same origin never overwrite each other's token.
   *
   * @param options - `account` to read a specific account's session
   */
  getSession(options: AccountOptions = {}): Session | null {
    const account = this.resolveAccount(options.account);
    return loadSession(account?.id);
  }

  /**
   * Persists a backend session token against an account.
   *
   * @param token - Session token returned by `/auth/verify`
   * @param options - `account` to scope the session; defaults to active
   * @param expiresAt - UNIX ms expiry; defaults to a conservative 15 minutes
   *   because the backend does not currently return a TTL
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when no account is resolved
   */
  setSession(token: string, options: AccountOptions = {}, expiresAt?: number): Session {
    const account = this.accounts.require(options.account);
    saveSession(token, account.address, expiresAt, account.id);
    return this.getSession(options) as Session;
  }

  /**
   * Clears the stored session for an account, leaving every other account's
   * session intact.
   *
   * @param options - `account` to clear; defaults to active
   * @returns `true` when a session was cleared
   */
  clearSession(options: AccountOptions = {}): boolean {
    const account = this.resolveAccount(options.account);
    if (!account) return false;
    clearSession(account.id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Servers & configuration
  // ---------------------------------------------------------------------------

  /**
   * Returns the underlying Horizon server instance for advanced operations.
   *
   * @returns Horizon.Server instance
   * @internal
   */
  getServer(): Horizon.Server {
    return this.server;
  }

  /**
   * Returns a shared Soroban RPC server instance, constructed on first use.
   *
   * Built from {@link rpcUrl}, which the constructor already defaults to
   * `SOROBAN_RPC_URLS[network]`, so a custom `rpcUrl` passed in `ClientConfig`
   * is honoured by every caller. The instance is cached, so contract calls
   * reuse one connection rather than building a throwaway server per call.
   * Plain-http URLs are refused unless the Stellar SDK's global
   * `Config.setAllowHttp(true)` is set (e.g. for a local quickstart node).
   *
   * Note: the Stellar SDK's `rpc.Server` (v15.x) ignores its `timeout`
   * constructor option, so request timeouts are enforced one layer up — every
   * call made through this server is bounded by
   * {@link ClientConfig.timeoutMs} via {@link import('./utils/timeout').withTimeout}
   * (see `readContractState` / `simulateContractCall` / `invokeContract`).
   *
   * @returns Cached rpc.Server instance for this client's network
   *
   * @example
   * ```typescript
   * const client = new TrustFlowClient({ network: 'testnet' });
   * const server = client.getSorobanServer();
   * const latest = await server.getLatestLedger();
   * ```
   */
  getSorobanServer(): rpc.Server {
    this.sorobanServer ??= new rpc.Server(this.rpcUrl, { allowHttp: Config.isAllowHttp() });
    return this.sorobanServer;
  }

  /**
   * Gets the network passphrase for transaction signing.
   *
   * @returns Network passphrase string
   */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * Creates authorization headers for API requests when apiKey is configured.
   *
   * A named or active account's own `apiKey` wins over the client-wide one, so
   * per-account credentials never bleed into another account's request.
   *
   * @param options - `account` to build headers for; defaults to active
   * @returns Headers object with authentication
   * @internal
   */
  getAuthHeaders(options: AccountOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SDK-Version': this.version,
      'X-API-Version': this.apiVersion,
    };

    const account = this.resolveAccount(options.account);
    if (account) {
      headers['X-TrustFlow-Account'] = account.id;
    }

    const apiKey = account?.apiKey ?? this.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  /**
   * Verifies that the client is connected before performing operations.
   *
   * @throws {TrustFlowError} If not connected
   * @internal
   */
  ensureConnected(): void {
    if (!this._connected) {
      throw new TrustFlowError('Client is not connected. Call connect() first.', 'NOT_CONNECTED');
    }
  }

  /**
   * Generates auto-bound, type-safe contract client methods from Soroban spec entries.
   *
   * The returned binding inherits this client's account context, so its
   * `invoke`/`read`/`simulate` calls can name an account per call.
   *
   * @param specEntries - Array of Soroban spec entries (XDR base64 strings, ScSpecEntry objects, or Buffers)
   * @param overrideContractId - Optional contract ID override (defaults to client's contractId)
   * @returns SorobanContractClient instance with bound spec methods
   *
   * @example
   * ```typescript
   * const binding = client.createContractBinding(specXdrEntries);
   * const res = await binding.methods.create_escrow({ depositor, beneficiary, amount, duration }, caller);
   * ```
   */
  createContractBinding<T extends Record<string, any> = Record<string, any>>(
    specEntries: (xdr.ScSpecEntry | string | Uint8Array | Buffer)[],
    overrideContractId?: string,
  ): SorobanContractClient & T & { methods: T } {
    return createContractBinding<T>(this, specEntries, overrideContractId);
  }

  /**
   * Returns a summary of the client configuration.
   *
   * @returns Object containing client configuration details
   */
  getConfig(): {
    network: Network;
    contractId: string;
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    apiConfigured: boolean;
    version: string;
    activeAccount: string | null;
    accountCount: number;
    retry: ApiRetryConfig | undefined;
  } {
    return {
      network: this.network,
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      horizonUrl: this.horizonUrl,
      networkPassphrase: this.networkPassphrase,
      apiConfigured: Boolean(this.apiBaseUrl && this.apiKey),
      version: this.version,
      activeAccount: this.accounts.active?.address ?? null,
      accountCount: this.accounts.size,
      retry: this.retryConfig,
    };
  }

  /**
   * Namespaces a balance cache key by account so two accounts never read each
   * other's cached balance, even for the same address.
   */
  private balanceCacheKey(address: string, account?: string): string {
    const context = this.resolveAccount(account);
    return context ? `${context.id}:${address}` : address;
  }
}
