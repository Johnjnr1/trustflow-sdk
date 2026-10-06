import {
  BASE_FEE,
  Config,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../client';
import type { AccountContext } from '../accounts/types';
import { TrustFlowError } from '../errors';
import { retry } from '../utils/retry';
import { classifyFailure, markTransient } from '../utils/transient';
import { withTimeout } from '../utils/timeout';
import { queueDepth, queueKey, runExclusive } from './queue';
import type {
  AssembleParams,
  EstimateFeeOptions,
  FeeBumpOptions,
  FeeBumpEvent,
  FeeEstimate,
  FeeRange,
  PipelineResult,
  PipelineSubmission,
  PrepareOptions,
  RetryPolicy,
  RunPipelineParams,
  SubmitOptions,
  SubmittableTransaction,
} from './types';
import { logger } from '../utils/logger';
import { installTraceContextInterceptor, withSdkSpan } from '../utils/tracing';

const DEFAULT_RETRY_POLICY: Required<Omit<RetryPolicy, 'timeoutMs'>> = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5000,
};

const DEFAULT_RESOURCE_FEE_MULTIPLIER = 1.1;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_ATTEMPTS = 10;

function ok<T>(data: T): PipelineResult<T> {
  return { ok: true, data };
}

function fail<T>(error: TrustFlowError): PipelineResult<T> {
  return { ok: false, error };
}

const FEE_RELATED_PATTERN = /TRY_AGAIN_LATER|insufficient.?fee|tx_insufficient_fee/i;

/**
 * Fee-related failures are the only ones worth escalating to a fee-bump
 * retry. `submit()` always surfaces a top-level `RETRY_EXHAUSTED` error, so
 * the fee-related detail (e.g. `TRY_AGAIN_LATER`) must be read off the
 * wrapped `cause`, not the outer message.
 */
function isFeeRelated(error: TrustFlowError): boolean {
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return FEE_RELATED_PATTERN.test(`${error.message} ${cause}`);
}

/** Only confirmation-poll exhaustion should trigger a fee bump, not RPC transport timeouts. */
function isConfirmationPollTimeout(error: unknown): boolean {
  if (error instanceof TrustFlowError) {
    if (
      (error.code === 'TIMEOUT' && error.message.includes('confirmation polling')) ||
      error.message.includes('timed out waiting for transaction')
    ) {
      return true;
    }
    return isConfirmationPollTimeout(error.cause);
  }
  if (error instanceof Error && 'cause' in error) {
    return isConfirmationPollTimeout(error.cause);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Peels one `RETRY_EXHAUSTED` wrapper off a stage error so a nested stage does
 * not hand the outer stage a doubly-wrapped failure.
 */
function unwrapStageError(error: TrustFlowError): unknown {
  if (error.code === 'RETRY_EXHAUSTED' && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

/**
 * Runs a pipeline stage under {@link RetryPolicy}, retrying **only transient**
 * failures.
 *
 * Retried: transport errors, timeouts, `429`/`5xx`, and the node's explicit
 * `TRY_AGAIN_LATER` deferral — the node told us it did not accept the
 * transaction, so resubmitting the identical envelope is safe.
 *
 * Not retried: simulation errors, a node `ERROR` rejection, and an on-chain
 * `FAILED` result. Replaying those re-sends a transaction that was already
 * processed and rejected, which cannot change the outcome and risks
 * double-submit confusion (#245). Those failures are surfaced as themselves, so
 * the caller gets the precise `SIMULATION_ERROR` / `SUBMISSION_ERROR` rather
 * than a generic `RETRY_EXHAUSTED` wrapper.
 *
 * `RETRY_EXHAUSTED` is reserved for what it says: a stage that really was
 * retried and really did run out of budget, with the last error as `cause`.
 *
 * When `policy.timeoutMs` is set, each attempt is additionally bounded by
 * {@link withTimeout}; a timed-out attempt is retried like any other
 * transient failure and surfaces as a `TIMEOUT` error once the budget is
 * spent.
 */
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy | undefined,
  stage: string,
  defaultTimeoutMs?: number,
): Promise<PipelineResult<T>> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_POLICY, ...policy };
  // Per-stage override, else the client-wide timeout every RPC call inherits.
  const timeoutMs = policy?.timeoutMs ?? defaultTimeoutMs;
  const isTransient = (error: unknown): boolean => classifyFailure(error).transient;

  try {
    const data = await retry(
      async (attempt: number) => withTimeout(fn(attempt), timeoutMs, `pipeline.${stage}`),
      {
        attempts: maxAttempts,
        delayMs: (attempt) => Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs),
        shouldRetry: isTransient,
        // Equal jitter: the delay lands in `[delay / 2, delay]`, which keeps the
        // "second delay is capped by maxDelayMs" guarantee intact while
        // desynchronising many pipelines that fail at the same moment.
        jitter: true,
      },
    );
    logger.debug('Pipeline stage succeeded', { stage, attempts: maxAttempts });
    return ok(data);
  } catch (e) {
    if (!isTransient(e)) {
      // A terminal failure: surface the real error so callers can branch on
      // its code instead of parsing a retry wrapper.
      return fail(TrustFlowError.wrap(e));
    }
    // A timeout is its own diagnosis — once the retry budget is spent, show
    // the `TIMEOUT` code itself rather than a generic retry-exhausted
    // wrapper, so callers can branch on "it stalled" without unwrapping.
    if (e instanceof TrustFlowError && e.code === 'TIMEOUT') {
      return fail(e);
    }
    return fail(TrustFlowError.retryExhausted(stage, maxAttempts, e));
  }
}

/**
 * Unified pipeline for assembling, simulating, fee-adjusting, fee-bumping,
 * and retrying Soroban transactions.
 *
 * Flow:
 *  1. `assemble` — builds an unsigned transaction envelope from a source
 *     account and one or more operations.
 *  2. `prepare` — simulates the transaction against Soroban RPC and folds
 *     the resulting footprint, auth entries, and resource fee back onto the
 *     transaction (with retry/backoff on transient RPC failures).
 *  3. `submit` — signs and broadcasts the transaction, polling for
 *     confirmation, optionally escalating to a fee-bump transaction when the
 *     network reports a fee-related rejection.
 *  4. `run` — convenience method chaining all of the above.
 *
 * `run` serializes runs per source account: a later run for the same account
 * (and network) waits until the earlier one has confirmed, failed or timed
 * out, then reads a fresh sequence number, so concurrent runs never build
 * transactions with the same sequence. Runs for different accounts proceed in
 * parallel. The queue is shared by every `TransactionPipeline` in the current
 * process; it does not coordinate across processes or machines, and the
 * low-level `assemble`/`submit` methods bypass it. Use `queueTimeoutMs` to fail
 * with a `TIMEOUT` error instead of waiting behind a stuck run. There is no
 * abort signal yet, so a run that has started keeps the queue until it reaches
 * a terminal state.
 *
 * Every method returns a {@link PipelineResult}, never throws for expected
 * failure modes, so callers get typed, actionable errors without try/catch.
 *
 * ### Retry policy
 *
 * Every stage retries **only transient** failures, using the same classifier as
 * the rest of the SDK. Network errors, timeouts, `429`/`5xx` and the node's
 * `TRY_AGAIN_LATER` deferral are retried with capped, jittered exponential
 * backoff, per stage, via `maxAttempts` / `baseDelayMs` / `maxDelayMs`.
 * Simulation errors, node `ERROR` rejections and on-chain `FAILED` results
 * fail fast and are returned unwrapped, so `result.error.code` is the precise
 * reason rather than a generic `RETRY_EXHAUSTED`. `RETRY_EXHAUSTED` (with the
 * last error as `cause`) is reserved for a stage that was retried and ran out
 * of budget.
 *
 * ### Timeouts
 *
 * The Stellar SDK's `rpc.Server` (v15.x) ignores its `timeout` constructor
 * option, so request timeouts are enforced one layer up: every stage's RPC
 * calls are raced against a deadline by `withTimeout`, defaulting to the
 * client-wide `ClientConfig.timeoutMs` and overridable per stage with
 * `RetryPolicy.timeoutMs`. Confirmation polling can additionally be bounded
 * by an overall `SubmitOptions.pollTimeoutMs` deadline on top of
 * `pollAttempts` x `pollIntervalMs`; both surface as `TIMEOUT` errors.
 *
 * @example
 * ```typescript
 * const pipeline = new TransactionPipeline(client);
 * const result = await pipeline.run({
 *   sourceAccount: senderPublicKey,
 *   operations: [contract.call('release', ...args)],
 *   signers: [senderKeypair],
 *   submit: { feeBump: { feeSource: sponsorKeypair } },
 * });
 *
 * if (!result.ok) {
 *   console.error(result.error.code, result.error.message);
 *   return;
 * }
 * console.log('confirmed:', result.data.hash);
 * ```
 */
export class TransactionPipeline {
  private readonly server: rpc.Server;
  private readonly pipelineLogger = logger;

  constructor(private readonly client: TrustFlowClient) {
    // Note: the Stellar SDK's `rpc.Server` (v15.x) ignores its `timeout`
    // constructor option, so request timeouts are enforced one layer up —
    // every stage's RPC calls are bounded by `withTimeout` in `withRetry`,
    // defaulting to the client-wide `ClientConfig.timeoutMs`.
    this.server = new rpc.Server(client.rpcUrl, { allowHttp: Config.isAllowHttp() });
  }

  /**
   * Resolves the account a stage should act as, mirroring every other
   * account-scoped method: an explicit id/address, else the client's active
   * account, else `null` in the pre-multi-account single-account case.
   *
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when a named account is unknown
   * @internal
   */
  resolveAccount(account?: string): AccountContext | null {
    return this.client.resolveAccount(account);
  }

  /**
   * Builds an unsigned transaction envelope from a source account and one or
   * more operations. Does not contact Soroban RPC beyond fetching the
   * source account's current sequence number.
   *
   * The `getAccount` read is retried on transient failures only (connection
   * reset, timeout, `429`, `5xx`) with capped, jittered backoff.
   *
   * @param params - Source account, operations, and optional memo/timeout/fee
   * @param options - Retry policy overrides
   */
  async assemble(
    params: AssembleParams,
    options?: RetryPolicy,
  ): Promise<PipelineResult<Transaction>> {
    try {
      const loaded = await withRetry(
        () => this.server.getAccount(params.sourceAccount),
        options,
        'assemble',
        this.client.timeoutMs,
      );
      if (!loaded.ok) {
        return fail(
          TrustFlowError.assemblyFailed(
            `could not assemble transaction for ${params.sourceAccount}`,
            loaded.error,
          ),
        );
      }

      const builder = new TransactionBuilder(loaded.data, {
        fee: params.fee ?? BASE_FEE,
        networkPassphrase: this.client.getNetworkPassphrase(),
      }).setTimeout(params.timeoutSeconds ?? 30);

      for (const operation of params.operations) {
        builder.addOperation(operation);
      }
      if (params.memo) {
        builder.addMemo(params.memo);
      }

      this.pipelineLogger.debug('Transaction assembled', { sourceAccount: params.sourceAccount });
      return ok(builder.build());
    } catch (e) {
      this.pipelineLogger.error('Transaction assembly failed', { sourceAccount: params.sourceAccount, error: e });
      return fail(
        TrustFlowError.assemblyFailed(
          `could not assemble transaction for ${params.sourceAccount}`,
          e,
        ),
      );
    }
  }

  /**
   * Simulates a transaction against Soroban RPC without mutating it.
   * Useful for inspecting cost/return value before committing to `prepare`.
   *
   * The `simulateTransaction` transport is retried on transient failures only.
   * A simulation *error* response is the node's verdict on the envelope, so it
   * is returned as `SIMULATION_ERROR` on the first attempt without a retry.
   *
   * @param tx - The transaction to simulate
   * @param options - Retry policy overrides
   */
  async simulate(
    tx: Transaction,
    options?: RetryPolicy,
  ): Promise<PipelineResult<rpc.Api.SimulateTransactionResponse>> {
    return withSdkSpan(
      this.client.getTracer(),
      'trustflow.tx.simulate',
      {
        'rpc.system': 'stellar',
        'rpc.method': 'simulateTransaction',
        'stellar.network': this.client.network,
      },
      async (span) => {
        span.setAttribute('transaction.hash', tx.hash().toString('hex'));
        const response = await withRetry(
          () => this.server.simulateTransaction(tx),
          options,
          'simulate',
          this.client.timeoutMs,
        );
        if (!response.ok) {
          if (response.error.code === 'RETRY_EXHAUSTED') {
            return fail(
              TrustFlowError.simulationFailed(
                'simulateTransaction request failed',
                response.error.cause,
              ),
            );
          }
          return fail(response.error);
        }
        if (rpc.Api.isSimulationError(response.data)) {
          return fail(TrustFlowError.simulationFailed(response.data.error));
        }
        if (rpc.Api.isSimulationRestore(response.data)) {
          return fail(
            TrustFlowError.simulationFailed(
              'simulation requires restore preamble',
              response.data.restorePreamble,
            ),
          );
        }
        return ok(response.data);
      },
    );
    const outcome = await withRetry(
      () => this.server.simulateTransaction(tx),
      options,
      'simulate',
      this.client.timeoutMs,
    );
    if (!outcome.ok) {
      if (outcome.error.code === 'RETRY_EXHAUSTED') {
        return fail(
          TrustFlowError.simulationFailed(
            'simulateTransaction request failed',
            outcome.error.cause,
          ),
        );
      }
      return fail(outcome.error);
    }
    const response = outcome.data;
    if (rpc.Api.isSimulationError(response)) {
      return fail(TrustFlowError.simulationFailed(response.error));
    }
    return ok(response);
  }

  /**
   * Estimates resource fee, inclusion fee, and execution costs for a transaction.
   *
   * @param tx - The transaction to estimate fees for
   * @param options - Fee estimation and retry options
   * @returns Breakdown of resource and inclusion fees with cost footprint
   */
  async estimateFee(
    tx: Transaction,
    options?: EstimateFeeOptions,
  ): Promise<PipelineResult<FeeEstimate>> {
    const simulation = await this.simulate(tx, options);
    if (!simulation.ok) {
      return simulation;
    }

    const simData = simulation.data;
    if (rpc.Api.isSimulationError(simData)) {
      return fail(TrustFlowError.simulationFailed(simData.error));
    }

    const multiplier = options?.resourceFeeMultiplier ?? DEFAULT_RESOURCE_FEE_MULTIPLIER;
    const multiplierBps = BigInt(Math.round(multiplier * 10000));
    const minResourceFeeBig = BigInt(simData.minResourceFee || '0');
    const resourceFee = ((minResourceFeeBig * multiplierBps + 9999n) / 10000n).toString();

    let minInclusionFee = BigInt(tx.fee || BASE_FEE);
    if (minInclusionFee <= 0n) {
      minInclusionFee = BigInt(BASE_FEE);
    }
    const recommendedInclusionFee = minInclusionFee * 2n;
    const maxInclusionFee = minInclusionFee * 10n;

    const tolerance = options?.toleranceMultiplier ?? 1.0;
    const tolBps = BigInt(Math.round(tolerance * 10000));
    const inclusionFee: FeeRange = {
      min: ((minInclusionFee * tolBps + 9999n) / 10000n).toString(),
      recommended: ((recommendedInclusionFee * tolBps + 9999n) / 10000n).toString(),
      max: ((maxInclusionFee * tolBps + 9999n) / 10000n).toString(),
    };

    const resFeeBig = BigInt(resourceFee);
    const total: FeeRange = {
      min: (resFeeBig + BigInt(inclusionFee.min)).toString(),
      recommended: (resFeeBig + BigInt(inclusionFee.recommended)).toString(),
      max: (resFeeBig + BigInt(inclusionFee.max)).toString(),
    };
    const cost = {
      cpuInsns: String((simData as any).cost?.cpuInsns ?? '0'),
      memBytes: String((simData as any).cost?.memBytes ?? (simData as any).cost?.memByte ?? '0'),
    };

    return ok({ resourceFee, inclusionFee, total, cost });
  }

  /**
   * Simulates the transaction and folds the resulting footprint, auth
   * entries, and resource fee back onto a new copy of it, applying a safety
   * multiplier on top of the RPC-reported minimum resource fee. Retries on
   * transient RPC failures using exponential backoff.
   *
   * @param tx - The assembled, unsigned transaction to prepare
   * @param options - Resource fee multiplier and retry policy
   */
  async prepare(tx: Transaction, options?: PrepareOptions): Promise<PipelineResult<Transaction>> {
    return withSdkSpan(
      this.client.getTracer(),
      'trustflow.tx.prepare',
      {
        'rpc.system': 'stellar',
        'rpc.method': 'simulateTransaction',
        'stellar.network': this.client.network,
      },
      async (span) => {
        const multiplier = options?.resourceFeeMultiplier ?? DEFAULT_RESOURCE_FEE_MULTIPLIER;
        span.setAttribute('transaction.fee_multiplier', multiplier);
        return withRetry(
          async () => {
            const simulation = await this.server.simulateTransaction(tx);
            if (rpc.Api.isSimulationError(simulation)) {
              throw TrustFlowError.simulationFailed(simulation.error);
            }
            if (rpc.Api.isSimulationRestore(simulation)) {
              throw TrustFlowError.simulationFailed(
                'simulation requires restore preamble',
                simulation.restorePreamble,
              );
            }

            const paddedFee = Math.ceil(Number(simulation.minResourceFee) * multiplier).toString();
            simulation.transactionData.setResourceFee(paddedFee);
            this.pipelineLogger.debug('Transaction prepared', {
              paddedFee,
              minResourceFee: simulation.minResourceFee,
            });
            return rpc.assembleTransaction(tx, { ...simulation, minResourceFee: paddedFee }).build();
          },
          options,
          'prepare',
          this.client.timeoutMs,
        );
    const multiplier = options?.resourceFeeMultiplier ?? DEFAULT_RESOURCE_FEE_MULTIPLIER;

    this.pipelineLogger.debug('Preparing transaction', { resourceFeeMultiplier: multiplier });
    return withRetry(
      async () => {
        const simulation = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simulation)) {
          throw TrustFlowError.simulationFailed(simulation.error);
        }
        if (rpc.Api.isSimulationRestore(simulation)) {
          throw TrustFlowError.simulationFailed(
            'simulation requires restore preamble',
            simulation.restorePreamble,
          );
        }

        const paddedFee = Math.ceil(Number(simulation.minResourceFee) * multiplier).toString();
        simulation.transactionData.setResourceFee(paddedFee);
        this.pipelineLogger.debug('Transaction prepared', { paddedFee, minResourceFee: simulation.minResourceFee });

        return rpc.assembleTransaction(tx, { ...simulation, minResourceFee: paddedFee }).build();
      },
      options,
      'prepare',
      this.client.timeoutMs,
    );
  }

  /**
   * Wraps an already-signed (or to-be-signed) inner transaction in a
   * fee-bump envelope, paid for by `options.feeSource`.
   *
   * The fee-bump base fee defaults to the inner transaction's fee. Stellar
   * requires the base fee to be at least the inner transaction's fee rate
   * (its inclusion fee per operation), and
   * `TransactionBuilder.buildFeeBumpTransaction` rejects anything lower, so
   * a fixed default cannot work for prepared Soroban transactions whose
   * inclusion fee is set at assembly time. The inner transaction's total fee
   * is always at least that rate, so the default is always valid.
   *
   * @param innerTx - The inner transaction to wrap
   * @param options - Fee source and base fee for the fee-bump envelope
   */
  buildFeeBump(innerTx: Transaction, options: FeeBumpOptions): PipelineResult<FeeBumpTransaction> {
    this.pipelineLogger.debug('Building fee-bump transaction', { feeSource: options.feeSource });
    try {
      const baseFee = options.baseFee ?? innerTx.fee;
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        options.feeSource,
        baseFee,
        innerTx,
        this.client.getNetworkPassphrase(),
      );
      this.pipelineLogger.debug('Fee-bump transaction built', { baseFee });
      return ok(feeBump);
    } catch (e) {
      this.pipelineLogger.error('Fee-bump transaction build failed', { error: e });
      return fail(TrustFlowError.feeBumpFailed('could not build fee-bump transaction', e));
    }
  }

  /**
   * Broadcasts a signed transaction and polls until it is confirmed on
   * ledger. Retries transient submission failures with capped, jittered
   * exponential backoff.
   *
   * A node `ERROR` rejection is **not** retried: the node reached a verdict
   * about the envelope, and the same bytes would be rejected identically.
   * `TRY_AGAIN_LATER` and a confirmation-poll timeout **are** retried, because
   * in both cases the node has not accepted the transaction and a replay of the
   * byte-identical envelope is the documented recovery.
   *
   * Confirmation polling is bounded by `pollAttempts` x `pollIntervalMs`, and
   * — when `pollTimeoutMs` is set — by that overall deadline too; the deadline
   * failing produces a `TIMEOUT` error rather than the generic
   * submission-failed one.
   *
   * @param tx - A fully signed transaction or fee-bump transaction
   * @param options - Poll interval/attempts, overall poll deadline, and retry policy
   */
  async submit(
    tx: SubmittableTransaction,
    options?: SubmitOptions,
  ): Promise<PipelineResult<PipelineSubmission>> {
    let result = await this.submitEnvelope(tx, options);
    const feeBumpOptions = options?.feeBump;
    const maxFeeBump = Math.max(0, Math.floor(feeBumpOptions?.maxFeeBump ?? 0));

    // Fee-bump envelopes cannot be nested. Rebuild every escalation around the
    // original signed inner transaction, and only auto-escalate a plain tx.
    if (
      result.ok ||
      !(tx instanceof Transaction) ||
      !feeBumpOptions ||
      maxFeeBump === 0 ||
      !isConfirmationPollTimeout(result.error)
    ) {
      return result;
    }

    const multiplier = feeBumpOptions.feeBumpMultiplier ?? 2;
    if (!Number.isFinite(multiplier) || multiplier <= 1) {
      this.pipelineLogger.warn('Invalid fee-bump multiplier; returning the original timeout');
      return result;
    }

    let currentEnvelope: SubmittableTransaction = tx;
    let previousBaseFee = BigInt(feeBumpOptions.baseFee ?? tx.fee);
    const multiplierBps = BigInt(Math.round(multiplier * 10_000));

    for (let bumpNumber = 1; bumpNumber <= maxFeeBump; bumpNumber++) {
      const stats = await withRetry(
        () => this.server.getFeeStats(),
        options,
        'submit.feeStats',
        this.client.timeoutMs,
      );
      if (!stats.ok) {
        this.pipelineLogger.warn('Could not read fee stats for automatic fee bump', {
          error: stats.error.message,
        });
        return result;
      }

      try {
        const feeStats = stats.data.sorobanInclusionFee.p90 || stats.data.inclusionFee.p90;
        const networkBaseFee = BigInt(feeStats);
        const baseline = [previousBaseFee, BigInt(tx.fee), networkBaseFee].reduce((max, fee) =>
          fee > max ? fee : max,
        );
        const baseFee = ((baseline * multiplierBps + 9_999n) / 10_000n).toString();
        const bumped = this.buildFeeBump(tx, { feeSource: feeBumpOptions.feeSource, baseFee });
        if (!bumped.ok) {
          this.pipelineLogger.warn('Automatic fee-bump construction failed', {
            error: bumped.error.message,
          });
          return result;
        }

        bumped.data.sign(feeBumpOptions.feeSource);
        await this.notifyFeeBump(feeBumpOptions, {
          previousHash: currentEnvelope.hash().toString('hex'),
          hash: bumped.data.hash().toString('hex'),
          baseFee,
          attempt: bumpNumber,
          reason: 'confirmation-timeout',
        });

        this.pipelineLogger.info('Resubmitting transaction with a higher fee', {
          bumpNumber,
          maxFeeBump,
          baseFee,
        });
        currentEnvelope = bumped.data;
        previousBaseFee = BigInt(baseFee);
        result = await this.submitEnvelope(bumped.data, { ...options, feeBump: undefined });
        if (result.ok || !isConfirmationPollTimeout(result.error)) {
          return result;
        }
      } catch (e) {
        this.pipelineLogger.warn('Automatic fee bump failed; returning the latest submission result', {
          error: e,
        });
        return result;
      }
    }

    return result;
  }

  private async notifyFeeBump(options: FeeBumpOptions, event: FeeBumpEvent): Promise<void> {
    try {
      await options.onFeeBump?.(event);
    } catch (error) {
      // Notifications must not prevent an already signed recovery envelope from
      // being submitted.
      this.pipelineLogger.warn('Fee-bump notification handler failed', { error });
    }
  }

  private async submitEnvelope(
    tx: SubmittableTransaction,
    options?: SubmitOptions,
  ): Promise<PipelineResult<PipelineSubmission>> {
    return withSdkSpan(
      this.client.getTracer(),
      'trustflow.tx.submit',
      {
        'rpc.system': 'stellar',
        'rpc.method': 'sendTransaction',
        'stellar.network': this.client.network,
      },
      async (span) => {
        span.setAttribute('transaction.hash', tx.hash().toString('hex'));
        span.setAttribute('stellar.fee_bump', tx instanceof FeeBumpTransaction);
        this.pipelineLogger.debug('Submitting transaction', {
          isFeeBump: tx instanceof FeeBumpTransaction,
        });
        return withRetry(
          async (attempt) => {
            this.pipelineLogger.debug('Sending transaction to network', {
              attempt,
              hash: tx.hash().toString('hex'),
            });
            const sendResult = await this.server.sendTransaction(tx);
            span.setAttribute('transaction.hash', sendResult.hash);

            if (sendResult.status === 'ERROR') {
              // Terminal: the node evaluated and rejected this envelope.
              throw TrustFlowError.submissionFailed(
                `node rejected transaction (${sendResult.hash})`,
                sendResult.errorResult,
              );
            }
            if (sendResult.status === 'TRY_AGAIN_LATER') {
              // The node explicitly deferred: nothing was broadcast, so a replay
              // is safe and expected.
              throw markTransient(TrustFlowError.submissionFailed('node reported TRY_AGAIN_LATER'));
            }

            const ledger = await this.pollForConfirmation(sendResult.hash, options);

            return {
              hash: sendResult.hash,
              ledger,
              feeBumped: tx instanceof FeeBumpTransaction,
              attempts: attempt,
              feeCharged: tx.fee,
            };
          },
          options,
          'submit',
          this.client.timeoutMs,
        );
    this.pipelineLogger.debug('Submitting transaction', { isFeeBump: tx instanceof FeeBumpTransaction });
    return withRetry(
      async (attempt) => {
        this.pipelineLogger.debug('Sending transaction to network', { attempt, hash: tx.hash?.toString() });
        const sendResult = await this.server.sendTransaction(tx);

        if (sendResult.status === 'ERROR') {
          // Terminal: the node evaluated and rejected this envelope.
          throw TrustFlowError.submissionFailed(
            `node rejected transaction (${sendResult.hash})`,
            sendResult.errorResult,
          );
        }
        if (sendResult.status === 'TRY_AGAIN_LATER') {
          // The node explicitly deferred: nothing was broadcast, so a replay
          // is safe and expected.
          throw markTransient(TrustFlowError.submissionFailed('node reported TRY_AGAIN_LATER'));
        }

        const ledger = await this.pollForConfirmation(sendResult.hash, options);

        return {
          hash: sendResult.hash,
          ledger,
          feeBumped: tx instanceof FeeBumpTransaction,
          attempts: attempt,
          feeCharged: tx.fee,
        };
      },
      options,
      'submit',
      this.client.timeoutMs,
    );
  }

  /**
   * Runs the full pipeline: assemble, prepare (simulate + auto-adjust
   * resource fee), sign, and submit. If the initial submission fails for a
   * fee-related reason and `submit.feeBump` is configured, automatically
   * builds and resubmits a fee-bump transaction before giving up.
   *
   * @param params - Assembly, signing, prepare, and submit configuration.
   *   `params.account` names the account context this run belongs to
   *   (defaulting to the client's active account).
   * @returns The confirmed submission, or a typed error. `ACCOUNT_NOT_FOUND`
   *   is returned — not thrown — when `params.account` is unregistered.
   */
  async run(params: RunPipelineParams): Promise<PipelineResult<PipelineSubmission>> {
    try {
      this.resolveAccount(params.account);
    } catch (e) {
      return fail(TrustFlowError.wrap(e));
    }

    if (params.serialize === false) {
      return this.execute(params);
    }

    try {
      return await runExclusive(
        queueKey(this.client.getNetworkPassphrase(), params.sourceAccount),
        () => this.execute(params),
        params.queueTimeoutMs,
      );
    } catch (e) {
      // Only the queue wait raises a TrustFlowError here; `execute` reports
      // expected failures through its result, so anything else is unexpected.
      if (e instanceof TrustFlowError && e.code === 'TIMEOUT') {
        this.pipelineLogger.error('Pipeline queue timeout', { sourceAccount: params.sourceAccount });
        return fail(e);
      }
      throw e;
    }
  }

  /**
   * Number of `run()` calls for `sourceAccount` on this pipeline's network
   * that are currently executing or waiting in the queue (in this process).
   *
   * @param sourceAccount - Public key (G...) of the source account
   */
  queueDepth(sourceAccount: string): number {
    return queueDepth(queueKey(this.client.getNetworkPassphrase(), sourceAccount));
  }

  private async execute(params: RunPipelineParams): Promise<PipelineResult<PipelineSubmission>> {
    const assembled = await this.assemble(params, params.prepare);
    if (!assembled.ok) {
      return assembled;
    }

    const prepared = await this.prepare(assembled.data, params.prepare);
    if (!prepared.ok) {
      return prepared;
    }

    this.pipelineLogger.debug('Signing transaction', { signersCount: params.signers.length });
    prepared.data.sign(...params.signers);

    const submitted = await this.submit(prepared.data, params.submit);
    if (submitted.ok) {
      this.pipelineLogger.info('Transaction confirmed', { hash: submitted.data.hash, ledger: submitted.data.ledger });
      return submitted;
    }

    this.pipelineLogger.warn('Transaction submission failed', { error: submitted.error.message });

    const feeBumpOptions = params.submit?.feeBump;
    if (!feeBumpOptions || !isFeeRelated(submitted.error)) {
      return submitted;
    }

    this.pipelineLogger.info('Attempting fee-bump retry', { feeSource: feeBumpOptions.feeSource });
    const feeBumped = this.buildFeeBump(prepared.data, feeBumpOptions);
    if (!feeBumped.ok) {
      // The escalation is a recovery attempt: if the fee-bump envelope cannot
      // even be built, the caller still needs the reason the original
      // submission failed, so surface that instead of the construction error.
      this.pipelineLogger.warn('Fee-bump build failed; returning the original submission error', {
        error: feeBumped.error.message,
      });
      return submitted;
    }

    feeBumped.data.sign(feeBumpOptions.feeSource);

    await this.notifyFeeBump(feeBumpOptions, {
      previousHash: prepared.data.hash().toString('hex'),
      hash: feeBumped.data.hash().toString('hex'),
      baseFee: feeBumpOptions.baseFee ?? prepared.data.fee,
      attempt: 1,
      reason: 'fee-rejection',
    });

    const escalatedSubmission = await this.submit(feeBumped.data, {
      ...params.submit,
      feeBump: undefined,
    });
    if (!escalatedSubmission.ok) {
      return escalatedSubmission;
    }

    this.pipelineLogger.info('Fee-bump transaction confirmed', { hash: escalatedSubmission.data.hash });
    return ok({ ...escalatedSubmission.data, feeBumped: true });
  }

  private async pollForConfirmation(
    hash: string,
    options?: SubmitOptions,
  ): Promise<number | undefined> {
    const attempts = options?.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    const intervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollTimeoutMs = options?.pollTimeoutMs;
    const deadline = pollTimeoutMs !== undefined ? Date.now() + pollTimeoutMs : undefined;

    /** True once the overall confirmation deadline has elapsed. */
    const deadlineExpired = (): boolean => deadline !== undefined && Date.now() >= deadline;

    /** The envelope may or may not have landed; the node never rejected it, so a replay is a valid recovery. */
    const throwDeadline = (): never => {
      throw markTransient(TrustFlowError.timedOut(pollTimeoutMs as number, 'confirmation polling'));
    };

    this.pipelineLogger.debug('Polling for transaction confirmation', {
      hash,
      maxAttempts: attempts,
      intervalMs,
      pollTimeoutMs,
    });

    for (let i = 0; i < attempts; i++) {
      if (deadlineExpired()) throwDeadline();

      const result = await withRetry(
        () => this.server.getTransaction(hash),
        options,
        'submit.poll',
        this.client.timeoutMs,
      );
      // Unwrap the poll stage's own retry wrapper so the surrounding
      // `submit` retry sees (and reports) the actual RPC failure once, rather
      // than a wrapper it would classify and re-wrap.
      if (!result.ok) throw unwrapStageError(result.error);

      if (result.data.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result.data.ledger;
      }
      if (result.data.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Terminal: the transaction is on the ledger and failed. Resending it
        // cannot change the result and only confuses double-submit tracking
        // (#245), so this is not marked transient.
        throw TrustFlowError.submissionFailed(`transaction ${hash} failed on-chain`);
      }

      if (i < attempts - 1) {
        // Cap the sleep so a long interval still observes the deadline promptly.
        const remaining = deadline === undefined ? intervalMs : Math.max(0, deadline - Date.now());
        await sleep(Math.min(intervalMs, remaining));
      }
    }

    if (deadlineExpired()) throwDeadline();

    // The envelope may or may not have landed; the node never rejected it, so
    // a replay of the identical envelope is a valid recovery.
    throw markTransient(
      TrustFlowError.submissionFailed(`timed out waiting for transaction ${hash} to confirm`),
    );
  }
}