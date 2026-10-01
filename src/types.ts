import type { IPFSConfig } from "./storage";
import type { ApiRetryConfig } from "./utils/http";
import type { AddAccountInput } from "./accounts/types";
import type { LogLevel, Logger } from "./utils/logger";
import type { Horizon, rpc } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./stellar/network";

export type Network = StellarNetwork;

/** Options for opt-in caching of Horizon balance lookups. */
export interface BalanceCacheConfig {
  /** Cache lifetime in milliseconds. Defaults to 5 seconds when caching is enabled. */
  ttlMs?: number;
}

/** Logging configuration for the SDK client */
export interface LoggingConfig {
  /** Minimum log level (default: "error"). Use "silent" to disable all logging. */
  level?: LogLevel;
  /** Custom logger instance (pino, winston, console, etc.). Overrides `level` if provided. */
  logger?: Logger;
  /** Enable JSON structured output (default: false) */
  json?: boolean;
}

/** Configuration options for initializing a TrustFlowClient instance. */
export interface ClientConfig {
  /** Target network. Defaults to "TESTNET". */
  network?: Network;
  /** Soroban contract ID for the TrustFlow protocol. */
  contractId: string;
  /** Custom Soroban RPC endpoint URL. */
  rpcUrl?: string;
  /** Custom Horizon server endpoint URL. */
  horizonUrl?: string;
  /** Custom Stellar network passphrase for private / standalone networks. */
  networkPassphrase?: string;
  /** Base URL for the TrustFlow backend API. */
  apiBaseUrl?: string;
  /** Optional API key for backend authenticated endpoints. */
  apiKey?: string;
  /** Expected API version string. */
  apiVersion?: string;
  /** Enables short-lived caching for `getBalance` calls. */
  balanceCache?: BalanceCacheConfig;
  /** Optional configuration for the built-in `storage.upload()` IPFS helper. */
  ipfs?: IPFSConfig;
  /** Retry budget for network and RPC calls. */
  retry?: ApiRetryConfig;
  /**
   * Default per-request timeout in milliseconds for Horizon and Soroban RPC
   * calls. Every per-call option (`ReadContractStateOptions.timeoutMs`,
   * `InvokeContractOptions.timeoutMs`, `TransactionPipeline`'s
   * `RetryPolicy.timeoutMs` / `SubmitOptions.pollTimeoutMs`) overrides it.
   * Defaults to 10s.
   */
  timeoutMs?: number;
  /** Initial accounts to configure on the client. */
  accounts?: AddAccountInput[];
  /** Dependency injection seam for testing: custom Soroban RPC server instance. */
  rpcServer?: rpc.Server;
  /** Dependency injection seam for testing: custom Horizon server instance. */
  horizonServer?: Horizon.Server;
  /** Logging configuration for the SDK client. */
  logging?: LoggingConfig;
}

/** Status of an escrow contract. */
export enum EscrowStatus {
  Pending = "PENDING",
  Active = "ACTIVE",
  Released = "RELEASED",
  Disputed = "DISPUTED",
  Cancelled = "CANCELLED",
}

/** Escrow entity representation. */
export interface Escrow {
  id: string;
  sender: string;
  recipient: string;
  amount: bigint;
  status: EscrowStatus;
  createdAt: number;
  expiresAt?: number;
  deadline?: number;
  metadata?: Record<string, string>;
}

/** Parameters for creating an escrow. */
export interface CreateEscrowParams {
  sender: string;
  recipient: string;
  amountStroops: bigint;
  durationBlocks?: number;
  deadline?: Date | number | string;
  expiresAt?: Date | number | string;
  milestones?: Array<{
    amount?: bigint;
    description?: string;
    deadline?: Date | number | string;
    expiration?: Date | number | string;
    [key: string]: unknown;
  }>;
  metadata?: Record<string, string>;
}

/** Parameters for releasing an escrow. */
export interface ReleaseEscrowParams {
  escrowId: string;
  caller: string;
}

/** Parameters for disputing an escrow. */
export interface DisputeEscrowParams {
  escrowId: string;
  caller: string;
  reason: string;
}
