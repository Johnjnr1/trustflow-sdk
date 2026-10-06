import type { FeeBumpTransaction, Keypair, Memo, Transaction, xdr } from '@stellar/stellar-sdk';
import type { TrustFlowError } from '../errors';

/**
 * Discriminated result type returned by every pipeline stage. Mirrors the
 * SDK-wide `SDKResult<T>` convention, but carries a typed {@link TrustFlowError}
 * (with a stable `code`) instead of a bare string, so callers can branch on
 * failure cause programmatically rather than by parsing an error message.
 */
export type PipelineResult<T> = { ok: true; data: T } | { ok: false; error: TrustFlowError };

/**
 * Controls retry/backoff behaviour for a single pipeline stage
 * (simulate+assemble, or submit).
 */
export interface RetryPolicy {
  /** Maximum number of attempts, including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in ms used for exponential backoff. Defaults to 300. */
  baseDelayMs?: number;
  /** Upper bound applied to any single backoff delay. Defaults to 5000. */
  maxDelayMs?: number;
  /**
   * Per-attempt timeout in milliseconds for the stage's RPC calls,
   * overriding the client-wide {@link ClientConfig.timeoutMs}. A timed-out
   * attempt is retried like any other transient failure and surfaces as a
   * `TIMEOUT` error once the budget is spent.
   */
  timeoutMs?: number;
}

/** Parameters required to assemble an unsigned transaction envelope. */
export interface AssembleParams {
  /** Public key (G...) of the account that will source and pay the base fee for the transaction. */
  sourceAccount: string;
  /** One or more operations to include, typically `contract.call(...)`. */
  operations: xdr.Operation[];
  /** Optional transaction memo. */
  memo?: Memo;
  /** Validity window, in seconds, from assembly time. Defaults to 30. */
  timeoutSeconds?: number;
  /** Base inclusion fee in stroops, before Soroban resource fees are added. Defaults to `BASE_FEE`. */
  fee?: string;
}

/** Options controlling how simulation results are folded back into a transaction. */
export interface PrepareOptions extends RetryPolicy {
  /**
   * Safety headroom applied on top of the RPC-reported `minResourceFee`, to
   * absorb small state changes between simulation and submission.
   * Defaults to 1.1 (10% headroom).
   */
  resourceFeeMultiplier?: number;
}

/** Fee estimation range in stroops. */
export interface FeeRange {
  /** Minimum fee needed for inclusion. */
  min: string;
  /** Recommended fee for reliable inclusion. */
  recommended: string;
  /** Maximum fee suggested for congested conditions. */
  max: string;
}

/** Estimated fees and execution costs for a transaction. */
export interface FeeEstimate {
  /** Estimated resource fee in stroops (including headroom). */
  resourceFee: string;
  /** Inclusion fee range in stroops. */
  inclusionFee: FeeRange;
  /** Total fee range (resource fee + inclusion fee) in stroops. */
  total: FeeRange;
  /** Execution resource footprint from simulation. */
  cost: {
    cpuInsns: string;
    memBytes: string;
  };
}

/** Options for estimating transaction fees. */
export interface EstimateFeeOptions extends PrepareOptions {
  /** Headroom multiplier on inclusion fee. Defaults to 1.0. */
  toleranceMultiplier?: number;
}

/** Configuration for escalating a submission into a fee-bumped transaction. */
export interface FeeBumpOptions {
  /** Keypair of the account that will pay the bumped fee and sign the fee-bump envelope. */
  feeSource: Keypair;
  /**
   * Fee in stroops for the fee-bump envelope. Defaults to the inner
   * transaction's fee, which always satisfies Stellar's requirement that the
   * fee-bump base fee cover the inner transaction's fee rate.
   */
  baseFee?: string;
  /**
   * Maximum number of additional fee-bump envelopes to submit after confirmation
   * polling times out. Automatic timeout escalation is disabled when omitted.
   */
  maxFeeBump?: number;
  /**
   * Fee multiplier applied at each timeout escalation step. The first bump
   * uses the latest RPC p90 inclusion fee times this multiplier; each later
   * bump increases the previous base fee by the same factor. Defaults to 2.
   */
  feeBumpMultiplier?: number;
  /** Called after a fee-bump envelope is built and signed, before it is submitted. */
  onFeeBump?: (event: FeeBumpEvent) => void | Promise<void>;
}

/** Details reported when the pipeline automatically creates a fee-bump envelope. */
export interface FeeBumpEvent {
  /** Hash of the envelope that most recently timed out or was fee-rejected. */
  previousHash: string;
  /** Hash of the newly created fee-bump envelope. */
  hash: string;
  /** Base fee used for the new fee-bump envelope, in stroops. */
  baseFee: string;
  /** One-based automatic bump number. */
  attempt: number;
  /** Why the escalation was started. */
  reason: 'confirmation-timeout' | 'fee-rejection';
}

/** Options controlling submission, on-chain confirmation polling, and fee-bump escalation. */
export interface SubmitOptions extends RetryPolicy {
  /** Interval between `getTransaction` polls while awaiting confirmation. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /** Maximum number of confirmation polls before timing out. Defaults to 10. */
  pollAttempts?: number;
  /**
   * Overall deadline in milliseconds for one confirmation-polling cycle,
   * bounding the total time spent waiting for the transaction to land
   * regardless of `pollAttempts` / `pollIntervalMs`. When it elapses the
   * poll fails with a `TIMEOUT` error (retried by the surrounding submit
   * stage, matching the existing poll-exhaustion behaviour). Defaults to
   * `pollAttempts` x `pollIntervalMs`.
   */
  pollTimeoutMs?: number;
  /**
   * When the initial submission fails for a fee-related reason (the node
   * reports `TRY_AGAIN_LATER` or rejects the transaction for insufficient
   * fee), automatically build and resubmit a fee-bump transaction using
   * this configuration.
   */
  feeBump?: FeeBumpOptions;
}

/** Outcome of a successfully confirmed submission. */
export interface PipelineSubmission {
  /** Hex-encoded transaction hash. */
  hash: string;
  /** Ledger sequence the transaction was included in, if known. */
  ledger?: number;
  /** Whether the confirmed transaction was a fee-bump escalation. */
  feeBumped: boolean;
  /** Total submission attempts made before confirmation. */
  attempts: number;
  /** Final fee (stroops) charged on the confirmed transaction envelope. */
  feeCharged: string;
}

/** End-to-end parameters for {@link TransactionPipeline.run}. */
export interface RunPipelineParams extends AssembleParams {
  /**
   * Account id or `G...` address this run belongs to. Defaults to the client's
   * active account. Recorded on the account's `lastUsedAt` so per-account
   * state stays attributable; an unregistered value throws
   * `ACCOUNT_NOT_FOUND` before any RPC call is made.
   */
  account?: string;
  /** Keypair(s) that must sign the assembled inner transaction. */
  signers: Keypair[];
  /** Options for the simulate+assemble stage. */
  prepare?: PrepareOptions;
  /** Options for the submit+confirm stage, including fee-bump escalation. */
  submit?: SubmitOptions;
  /**
   * Wait for earlier `run()` calls with the same source account (on the same
   * network, across all pipeline instances in this process) to finish before
   * fetching a sequence number. Set to `false` to skip the queue. Defaults to `true`.
   */
  serialize?: boolean;
  /**
   * Maximum time in ms to wait behind earlier runs before failing with a
   * `TIMEOUT` error. Waits indefinitely when omitted. Ignored when `serialize` is `false`.
   */
  queueTimeoutMs?: number;
}

/** Union of transaction types the pipeline can submit. */
export type SubmittableTransaction = Transaction | FeeBumpTransaction;
