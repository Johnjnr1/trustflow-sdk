import {
  Account,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Networks,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { TransactionPipeline } from '../src/tx-pipeline';
import { TrustFlowClient } from '../src/client';
import { TrustFlowError } from '../src/errors';

const CONTRACT_ID = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';

function makeClient(): TrustFlowClient {
  return new TrustFlowClient({ contractId: CONTRACT_ID, network: 'TESTNET' });
}

function expectValidEnvelopeXdr(xdrString: string): void {
  expect(() => xdr.TransactionEnvelope.fromXDR(xdrString, 'base64')).not.toThrow();
}

function buildUnsignedTx(source: string, fee = BASE_FEE): Transaction {
  const account = new Account(source, '100');
  const contract = new Contract(CONTRACT_ID);
  return new TransactionBuilder(account, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call('increment'))
    .setTimeout(30)
    .build();
}

function simSuccess(minResourceFee: string): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

function simError(message: string): rpc.Api.SimulateTransactionErrorResponse {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error: message };
}

describe('TransactionPipeline.assemble', () => {
  afterEach(() => jest.restoreAllMocks());

  it('assembles a transaction whose XDR round-trips', async () => {
    const source = Keypair.random().publicKey();
    jest.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(new Account(source, '100'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.assemble({
      sourceAccount: source,
      operations: [new Contract(CONTRACT_ID).call('increment')],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeInstanceOf(Transaction);
    expectValidEnvelopeXdr(result.data.toXDR());
    expect(() => TransactionBuilder.fromXDR(result.data.toXDR(), Networks.TESTNET)).not.toThrow();
  });

  it('surfaces a typed ASSEMBLY_ERROR when the source account cannot be loaded', async () => {
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockRejectedValue(new Error('account not found'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.assemble({
      sourceAccount: Keypair.random().publicKey(),
      operations: [new Contract(CONTRACT_ID).call('increment')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(TrustFlowError);
    expect(result.error.code).toBe('ASSEMBLY_ERROR');
  });
});

describe('TransactionPipeline.prepare', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pads the resource fee reported by simulation onto the transaction fee', async () => {
    const source = Keypair.random().publicKey();
    const tx = buildUnsignedTx(source);
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess('1000'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.prepare(tx, { resourceFeeMultiplier: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.data.fee)).toBe(Number(BASE_FEE) + 2000);
    expectValidEnvelopeXdr(result.data.toXDR());
  });

  it('retries transient simulation failures before succeeding', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const spy = jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('network blip'))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(simSuccess('500'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.prepare(tx, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 });

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('surfaces RETRY_EXHAUSTED with the underlying cause once retries run out', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValue(new Error('rpc down'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.prepare(tx, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RETRY_EXHAUSTED');
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  it('fails fast on a simulation error response without retrying (#245)', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const spy = jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue(simError('Error(Contract, #1)'));

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.prepare(tx, { maxAttempts: 3, baseDelayMs: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A simulation error is the node's verdict on the envelope, not a transport
    // blip, so it surfaces as itself instead of a RETRY_EXHAUSTED wrapper.
    expect(result.error.code).toBe('SIMULATION_ERROR');
    expect(result.error.message).toContain('Error(Contract, #1)');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionPipeline.buildFeeBump', () => {
  it('builds a fee-bump envelope that round-trips through TransactionBuilder.fromXDR', () => {
    const sourceKeypair = Keypair.random();
    const feeSource = Keypair.random();
    const inner = buildUnsignedTx(sourceKeypair.publicKey());
    inner.sign(sourceKeypair);

    const pipeline = new TransactionPipeline(makeClient());
    const result = pipeline.buildFeeBump(inner, { feeSource, baseFee: '1000' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.data.sign(feeSource);
    expect(result.data).toBeInstanceOf(FeeBumpTransaction);

    const envelope = xdr.TransactionEnvelope.fromXDR(result.data.toXDR(), 'base64');
    expect(envelope.switch()).toEqual(xdr.EnvelopeType.envelopeTypeTxFeeBump());

    const decoded = TransactionBuilder.fromXDR(result.data.toXDR(), Networks.TESTNET);
    expect(decoded).toBeInstanceOf(FeeBumpTransaction);
  });

  it('surfaces a typed FEE_BUMP_ERROR when the base fee is below the network minimum', () => {
    const sourceKeypair = Keypair.random();
    const inner = buildUnsignedTx(sourceKeypair.publicKey());
    inner.sign(sourceKeypair);

    const pipeline = new TransactionPipeline(makeClient());
    const result = pipeline.buildFeeBump(inner, { feeSource: Keypair.random(), baseFee: '1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(TrustFlowError);
    expect(result.error.code).toBe('FEE_BUMP_ERROR');
  });

  it('defaults the base fee to the inner transaction fee when none is given', () => {
    const sourceKeypair = Keypair.random();
    // A one-operation inner transaction with a 50,100-stroop fee: the old
    // fixed default of 1,000 stroops was rejected here with "Invalid baseFee,
    // it should be at least 50100 stroops".
    const inner = buildUnsignedTx(sourceKeypair.publicKey(), '50100');
    inner.sign(sourceKeypair);

    const pipeline = new TransactionPipeline(makeClient());
    const result = pipeline.buildFeeBump(inner, { feeSource: Keypair.random() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fee-bump base fee is the inner fee, so the envelope pays
    // innerFee × (operations + 1).
    expect(result.data.fee).toBe(String(Number(inner.fee) * 2));
  });

  it('defaults the base fee to the inner fee for a prepared Soroban transaction', () => {
    const sourceKeypair = Keypair.random();
    // What prepare() produces for a 50,000-stroop resource fee: inclusion
    // fee plus resource fee, with the resource fee in the Soroban data.
    const resourceFee = '50000';
    const inner = new TransactionBuilder(new Account(sourceKeypair.publicKey(), '100'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(CONTRACT_ID).call('increment'))
      .setTimeout(30)
      .setSorobanData(new SorobanDataBuilder().setResourceFee(resourceFee).build())
      .build();
    inner.sign(sourceKeypair);

    const pipeline = new TransactionPipeline(makeClient());
    const result = pipeline.buildFeeBump(inner, { feeSource: Keypair.random() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fee-bump envelope pays the base fee per operation (including the
    // fee-bump operation itself) plus the inner resource fee.
    expect(result.data.fee).toBe(String(Number(inner.fee) * 2 + Number(resourceFee)));
  });
});

describe('TransactionPipeline.submit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('confirms a transaction that is accepted and included on the first attempt', async () => {
    const sourceKeypair = Keypair.random();
    const tx = buildUnsignedTx(sourceKeypair.publicKey());
    tx.sign(sourceKeypair);

    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
      status: 'PENDING',
      hash: 'deadbeef',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 42,
    } as unknown as rpc.Api.GetTransactionResponse);

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.submit(tx, { pollIntervalMs: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      hash: 'deadbeef',
      ledger: 42,
      feeBumped: false,
      attempts: 1,
      feeCharged: tx.fee,
    });
  });

  it('retries after TRY_AGAIN_LATER and succeeds on the next attempt', async () => {
    const sourceKeypair = Keypair.random();
    const tx = buildUnsignedTx(sourceKeypair.publicKey());
    tx.sign(sourceKeypair);

    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce({
        status: 'TRY_AGAIN_LATER',
        hash: 'deadbeef',
        latestLedger: 1,
        latestLedgerCloseTime: 1,
      })
      .mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'deadbeef',
        latestLedger: 2,
        latestLedgerCloseTime: 2,
      });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 43,
    } as unknown as rpc.Api.GetTransactionResponse);

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.submit(tx, { maxAttempts: 2, baseDelayMs: 1, pollIntervalMs: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.attempts).toBe(2);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('fails fast with a SUBMISSION_ERROR when the node rejects the transaction', async () => {
    const sourceKeypair = Keypair.random();
    const tx = buildUnsignedTx(sourceKeypair.publicKey());
    tx.sign(sourceKeypair);

    const sendSpy = jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
      status: 'ERROR',
      hash: 'deadbeef',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.submit(tx, { maxAttempts: 2, baseDelayMs: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A node ERROR is a verdict on this exact envelope; replaying it would be
    // rejected identically, so it is not retried and is not wrapped.
    expect(result.error.code).toBe('SUBMISSION_ERROR');
    expect(result.error.message).toContain('node rejected transaction');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionPipeline.run', () => {
  afterEach(() => jest.restoreAllMocks());

  it('assembles, prepares, signs, and submits a transaction end-to-end', async () => {
    const source = Keypair.random();
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(source.publicKey(), '100'));
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess('500'));
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
      status: 'PENDING',
      hash: 'cafebabe',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 7,
    } as unknown as rpc.Api.GetTransactionResponse);

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.run({
      sourceAccount: source.publicKey(),
      operations: [new Contract(CONTRACT_ID).call('increment')],
      signers: [source],
      submit: { pollIntervalMs: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.feeBumped).toBe(false);
    expect(result.data.hash).toBe('cafebabe');
  });

  it('escalates to a fee-bump transaction when submission is fee-rejected', async () => {
    const source = Keypair.random();
    const sponsor = Keypair.random();

    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(source.publicKey(), '100'));
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess('500'));

    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce({
        status: 'TRY_AGAIN_LATER',
        hash: 'first',
        latestLedger: 1,
        latestLedgerCloseTime: 1,
      })
      .mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'second',
        latestLedger: 2,
        latestLedgerCloseTime: 2,
      });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 9,
    } as unknown as rpc.Api.GetTransactionResponse);

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.run({
      sourceAccount: source.publicKey(),
      operations: [new Contract(CONTRACT_ID).call('increment')],
      signers: [source],
      submit: {
        maxAttempts: 1,
        pollIntervalMs: 1,
        feeBump: { feeSource: sponsor, baseFee: '5000' },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.feeBumped).toBe(true);
    expect(result.data.hash).toBe('second');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('escalates with the default base fee when feeBump omits baseFee', async () => {
    const source = Keypair.random();
    const sponsor = Keypair.random();

    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(source.publicKey(), '100'));
    // A realistic Soroban resource fee: the prepared inner fee is the
    // inclusion fee plus this, far above the old fixed 1,000-stroop default.
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess('50000'));

    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce({
        status: 'TRY_AGAIN_LATER',
        hash: 'first',
        latestLedger: 1,
        latestLedgerCloseTime: 1,
      })
      .mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'second',
        latestLedger: 2,
        latestLedgerCloseTime: 2,
      });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 9,
    } as unknown as rpc.Api.GetTransactionResponse);

    const pipeline = new TransactionPipeline(makeClient());
    const result = await pipeline.run({
      sourceAccount: source.publicKey(),
      operations: [new Contract(CONTRACT_ID).call('increment')],
      signers: [source],
      submit: {
        maxAttempts: 1,
        pollIntervalMs: 1,
        feeBump: { feeSource: sponsor },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.feeBumped).toBe(true);
    expect(result.data.hash).toBe('second');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });
});

describe('TransactionPipeline.simulate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the simulation response on success', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const response = simSuccess('900');
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(response);

    const result = await new TransactionPipeline(makeClient()).simulate(tx);

    expect(result).toEqual({ ok: true, data: response });
  });

  it('surfaces a SIMULATION_ERROR when the simulation reports an error', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const spy = jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue(simError('Error(Contract, #2)'));

    const result = await new TransactionPipeline(makeClient()).simulate(tx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SIMULATION_ERROR');
    expect(result.error.message).toContain('Error(Contract, #2)');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a SIMULATION_ERROR with the cause when the RPC call throws', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const failure = new Error('rpc down');
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(failure);

    const result = await new TransactionPipeline(makeClient()).simulate(tx, { maxAttempts: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SIMULATION_ERROR');
    expect(result.error.message).toContain('simulateTransaction request failed');
    expect(result.error.cause).toBe(failure);
  });

  it('retries a transient RPC failure before succeeding', async () => {
    const tx = buildUnsignedTx(Keypair.random().publicKey());
    const response = simSuccess('900');
    const spy = jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(response);

    const result = await new TransactionPipeline(makeClient()).simulate(tx, {
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    expect(result).toEqual({ ok: true, data: response });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('TransactionPipeline.assemble options', () => {
  afterEach(() => jest.restoreAllMocks());

  it('applies the memo, fee and timeout', async () => {
    const source = Keypair.random().publicKey();
    jest.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(new Account(source, '100'));

    const before = Math.floor(Date.now() / 1000);
    const result = await new TransactionPipeline(makeClient()).assemble({
      sourceAccount: source,
      operations: [new Contract(CONTRACT_ID).call('increment')],
      memo: Memo.text('escrow-1'),
      fee: '500',
      timeoutSeconds: 60,
    });
    const after = Math.floor(Date.now() / 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.memo.type).toBe('text');
    expect(String(result.data.memo.value)).toBe('escrow-1');
    expect(result.data.fee).toBe('500');
    const maxTime = Number(result.data.timeBounds?.maxTime);
    expect(maxTime).toBeGreaterThanOrEqual(before + 60);
    expect(maxTime).toBeLessThanOrEqual(after + 60);
  });

  it('defaults to no memo, the base fee and a 30 second window', async () => {
    const source = Keypair.random().publicKey();
    jest.spyOn(rpc.Server.prototype, 'getAccount').mockResolvedValue(new Account(source, '100'));

    const before = Math.floor(Date.now() / 1000);
    const result = await new TransactionPipeline(makeClient()).assemble({
      sourceAccount: source,
      operations: [new Contract(CONTRACT_ID).call('increment')],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.memo.type).toBe('none');
    expect(result.data.fee).toBe(BASE_FEE);
    expect(Number(result.data.timeBounds?.maxTime)).toBeGreaterThanOrEqual(before + 30);
  });
});

describe('TransactionPipeline.submit confirmation polling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function signedTx(): Transaction {
    const keypair = Keypair.random();
    const tx = buildUnsignedTx(keypair.publicKey());
    tx.sign(keypair);
    return tx;
  }

  function pending(hash = 'deadbeef'): rpc.Api.SendTransactionResponse {
    return { status: 'PENDING', hash, latestLedger: 1, latestLedgerCloseTime: 1 };
  }

  function txStatus(status: rpc.Api.GetTransactionStatus, ledger?: number) {
    return { status, ledger } as unknown as rpc.Api.GetTransactionResponse;
  }

  it('keeps polling through NOT_FOUND until the transaction succeeds', async () => {
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue(pending());
    const getSpy = jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.SUCCESS, 77));

    const result = await new TransactionPipeline(makeClient()).submit(signedTx(), {
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ledger).toBe(77);
    expect(getSpy).toHaveBeenCalledTimes(3);
  });

  it('fails with a SUBMISSION_ERROR when the transaction fails on-chain', async () => {
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue(pending('abc123'));
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValue(txStatus(rpc.Api.GetTransactionStatus.FAILED));

    const result = await new TransactionPipeline(makeClient()).submit(signedTx(), {
      maxAttempts: 3,
      baseDelayMs: 1,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SUBMISSION_ERROR');
    expect(result.error.message).toContain('transaction abc123 failed on-chain');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  // Fixed by the transient-aware `withRetry`: an on-chain FAILED result is
  // terminal, so the pipeline no longer re-sends the same signed transaction.
  it('does not resend a transaction that already failed on-chain (#245)', async () => {
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue(pending());
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValue(txStatus(rpc.Api.GetTransactionStatus.FAILED));

    await new TransactionPipeline(makeClient()).submit(signedTx(), {
      maxAttempts: 3,
      baseDelayMs: 1,
      pollIntervalMs: 1,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('times out after exhausting pollAttempts', async () => {
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue(pending('slow'));
    const getSpy = jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValue(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND));

    const result = await new TransactionPipeline(makeClient()).submit(signedTx(), {
      maxAttempts: 1,
      pollAttempts: 3,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.cause as TrustFlowError).message).toContain(
      'timed out waiting for transaction slow to confirm',
    );
    expect(getSpy).toHaveBeenCalledTimes(3);
  });

  it('automatically fee-bumps a timed-out transaction using current Soroban fee stats', async () => {
    const tx = signedTx();
    const feeSource = Keypair.random();
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce(pending('original'))
      .mockResolvedValueOnce(pending('bumped'));
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.SUCCESS, 88));
    const feeStatsSpy = jest.spyOn(rpc.Server.prototype, 'getFeeStats').mockResolvedValue({
      latestLedger: 100,
      inclusionFee: { p90: '500' },
      sorobanInclusionFee: { p90: '600' },
    } as unknown as rpc.Api.GetFeeStatsResponse);
    const notifications: Array<{ hash: string; baseFee: string; attempt: number }> = [];

    const result = await new TransactionPipeline(makeClient()).submit(tx, {
      maxAttempts: 1,
      pollAttempts: 1,
      pollIntervalMs: 1,
      feeBump: {
        feeSource,
        maxFeeBump: 2,
        onFeeBump: ({ hash, baseFee, attempt }) => notifications.push({ hash, baseFee, attempt }),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ hash: 'bumped', ledger: 88, feeBumped: true });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[1][0]).toBeInstanceOf(FeeBumpTransaction);
    expect(feeStatsSpy).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ baseFee: '1200', attempt: 1 });
    expect(notifications[0].hash).toBe((sendSpy.mock.calls[1][0] as FeeBumpTransaction).hash().toString('hex'));
  });

  it('steps the fee up for each retry and stops at maxFeeBump', async () => {
    const tx = signedTx();
    const feeSource = Keypair.random();
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce(pending('original'))
      .mockResolvedValueOnce(pending('first-bump'))
      .mockResolvedValueOnce(pending('second-bump'));
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.SUCCESS, 89));
    jest
      .spyOn(rpc.Server.prototype, 'getFeeStats')
      .mockResolvedValue({
        latestLedger: 100,
        inclusionFee: { p90: '500' },
        sorobanInclusionFee: { p90: '600' },
      } as unknown as rpc.Api.GetFeeStatsResponse);
    const notifications: Array<{ baseFee: string; attempt: number }> = [];

    const result = await new TransactionPipeline(makeClient()).submit(tx, {
      maxAttempts: 1,
      pollAttempts: 1,
      pollIntervalMs: 1,
      feeBump: {
        feeSource,
        maxFeeBump: 2,
        onFeeBump: ({ baseFee, attempt }) => notifications.push({ baseFee, attempt }),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hash).toBe('second-bump');
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(notifications).toEqual([
      { baseFee: '1200', attempt: 1 },
      { baseFee: '2400', attempt: 2 },
    ]);
  });

  it('surfaces a getTransaction failure raised mid-poll', async () => {
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue(pending());
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValueOnce(txStatus(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockRejectedValueOnce(new Error('rpc down'));

    const result = await new TransactionPipeline(makeClient()).submit(signedTx(), {
      maxAttempts: 1,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RETRY_EXHAUSTED');
    expect((result.error.cause as Error).message).toBe('rpc down');
  });
  it('reports feeBumped and the fee of a fee-bump envelope', async () => {
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue(pending());
    jest
      .spyOn(rpc.Server.prototype, 'getTransaction')
      .mockResolvedValue(txStatus(rpc.Api.GetTransactionStatus.SUCCESS, 5));
    const feeSource = Keypair.random();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '1000',
      signedTx(),
      Networks.TESTNET,
    );
    feeBump.sign(feeSource);

    const result = await new TransactionPipeline(makeClient()).submit(feeBump, {
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.feeBumped).toBe(true);
    expect(result.data.feeCharged).toBe(feeBump.fee);
  });

  it('passes the retry policy overrides through to the retry helper', async () => {
    jest.useFakeTimers();
    // TRY_AGAIN_LATER is the transient submission failure, so it still drives
    // the backoff schedule the policy overrides configure. The schedule itself
    // is asserted deterministically in `cappedExponentialBackoff` unit tests;
    // here we only assert that the pipeline honours the configured numbers.
    const sendSpy = jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
      status: 'TRY_AGAIN_LATER',
      hash: 'deadbeef',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });

    const submission = new TransactionPipeline(makeClient()).submit(signedTx(), {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
    });

    // Equal jitter keeps each delay inside [delay / 2, delay], so 49ms cannot
    // have been enough for the first retry.
    await jest.advanceTimersByTimeAsync(49);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(sendSpy).toHaveBeenCalledTimes(3);

    const result = await submission;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('3 attempt(s)');
  });
});

describe('TransactionPipeline.run failure paths', () => {
  afterEach(() => jest.restoreAllMocks());

  function runParams(source: Keypair, submit: Record<string, unknown> = {}) {
    return {
      sourceAccount: source.publicKey(),
      operations: [new Contract(CONTRACT_ID).call('increment')],
      signers: [source],
      prepare: { maxAttempts: 1 },
      submit: { maxAttempts: 1, pollIntervalMs: 1, ...submit },
    };
  }

  function mockAssembleAndPrepare(source: Keypair) {
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(source.publicKey(), '100'));
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess('500'));
  }

  function sendResult(status: 'ERROR' | 'TRY_AGAIN_LATER' | 'PENDING', hash = 'h') {
    return {
      status,
      hash,
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    } as rpc.Api.SendTransactionResponse;
  }

  it('returns the assembly error and makes no further RPC calls', async () => {
    const source = Keypair.random();
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockRejectedValue(new Error('account not found'));
    const simSpy = jest.spyOn(rpc.Server.prototype, 'simulateTransaction');
    const sendSpy = jest.spyOn(rpc.Server.prototype, 'sendTransaction');

    const result = await new TransactionPipeline(makeClient()).run(runParams(source));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ASSEMBLY_ERROR');
    expect(simSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns the prepare error and never submits', async () => {
    const source = Keypair.random();
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(source.publicKey(), '100'));
    jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValue(simError('Error(Contract, #1)'));
    const sendSpy = jest.spyOn(rpc.Server.prototype, 'sendTransaction');

    const result = await new TransactionPipeline(makeClient()).run(runParams(source));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SIMULATION_ERROR');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns the submission error when no fee bump is configured', async () => {
    const source = Keypair.random();
    mockAssembleAndPrepare(source);
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue(sendResult('TRY_AGAIN_LATER'));
    const getSpy = jest.spyOn(rpc.Server.prototype, 'getTransaction');

    const result = await new TransactionPipeline(makeClient()).run(runParams(source));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RETRY_EXHAUSTED');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('does not escalate a submission failure that is not fee-related', async () => {
    const source = Keypair.random();
    mockAssembleAndPrepare(source);
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue(sendResult('ERROR'));

    const result = await new TransactionPipeline(makeClient()).run(
      runParams(source, { feeBump: { feeSource: Keypair.random(), baseFee: '5000' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SUBMISSION_ERROR');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the original submission error when the fee-bump envelope cannot be built', async () => {
    const source = Keypair.random();
    mockAssembleAndPrepare(source);
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValue(sendResult('TRY_AGAIN_LATER'));

    const result = await new TransactionPipeline(makeClient()).run(
      runParams(source, { feeBump: { feeSource: Keypair.random(), baseFee: '1' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A fee-bump construction failure must not hide why the first submission
    // failed: the caller needs the original reason to act on it.
    expect(result.error.code).toBe('RETRY_EXHAUSTED');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the error of a failed escalated submission', async () => {
    const source = Keypair.random();
    mockAssembleAndPrepare(source);
    const sendSpy = jest
      .spyOn(rpc.Server.prototype, 'sendTransaction')
      .mockResolvedValueOnce(sendResult('TRY_AGAIN_LATER'))
      .mockResolvedValueOnce(sendResult('ERROR', 'bumped'));

    const result = await new TransactionPipeline(makeClient()).run(
      runParams(source, { feeBump: { feeSource: Keypair.random(), baseFee: '5000' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The escalated attempt is a fresh node ERROR, so it surfaces directly.
    expect(result.error.code).toBe('SUBMISSION_ERROR');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('returns ACCOUNT_NOT_FOUND for an unregistered account before any RPC call', async () => {
    const source = Keypair.random();
    const getSpy = jest.spyOn(rpc.Server.prototype, 'getAccount');
    const sendSpy = jest.spyOn(rpc.Server.prototype, 'sendTransaction');

    const result = await new TransactionPipeline(makeClient()).run({
      ...runParams(source),
      account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(getSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
