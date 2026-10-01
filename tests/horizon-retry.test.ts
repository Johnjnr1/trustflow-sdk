import { fetchAccountInfo } from '../src/stellar/account';
import { TrustFlowClient } from '../src/client';
import { TrustFlowError } from '../src/errors';

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const FAST = { retries: 2, retryDelayMs: 1, maxRetryDelayMs: 1 };

/** A minimal fetch Response stand-in; jsdom/undici details are irrelevant here. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function accountPayload(balance = '42.0000000', sequence = '12345') {
  return { balances: [{ asset_type: 'native', balance }], sequence };
}

describe('fetchAccountInfo', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns the balance and sequence for an active account', async () => {
    fetchMock.mockResolvedValue(respond(200, accountPayload()));

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).resolves.toEqual({
      address: ALICE,
      balanceXLM: '42.0000000',
      sequenceNumber: '12345',
      isActive: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(`${TESTNET_HORIZON}/accounts/${ALICE}`);
  });

  it('reports a genuinely unfunded account as inactive, on the first attempt', async () => {
    fetchMock.mockResolvedValue(respond(404, { status: 404 }));

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).resolves.toEqual({
      address: ALICE,
      balanceXLM: '0',
      sequenceNumber: '0',
      isActive: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure and then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('failed to fetch'))
      .mockResolvedValueOnce(respond(200, accountPayload('7.5000000')));

    const info = await fetchAccountInfo(ALICE, 'TESTNET', FAST);
    expect(info.isActive).toBe(true);
    expect(info.balanceXLM).toBe('7.5000000');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, { status: 503 }))
      .mockResolvedValueOnce(respond(200, accountPayload()));

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).resolves.toMatchObject({
      isActive: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT report a persistent outage as an inactive account', async () => {
    // Regression guard: the old implementation swallowed every error and
    // returned isActive: false, so a Horizon blip looked like an unfunded
    // account and callers told users to fund an account that had money.
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-404 4xx', async () => {
    fetchMock.mockResolvedValue(respond(403, { status: 403 }));

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours a Retry-After header on 429 instead of its own backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(respond(200, accountPayload()));

    // A large base delay would stall the test if Retry-After were ignored.
    await expect(
      fetchAccountInfo(ALICE, 'TESTNET', {
        retries: 2,
        retryDelayMs: 50_000,
        maxRetryDelayMs: 50_000,
      }),
    ).resolves.toMatchObject({ isActive: true });
  });

  it('throws on an unparseable payload rather than reporting isActive false', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    await expect(fetchAccountInfo(ALICE, 'TESTNET', FAST)).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });
});

describe('TrustFlowClient.getBalance retry behaviour', () => {
  it('retries a transient Horizon failure and then succeeds', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    const loadAccount = jest
      .spyOn(client.getServer(), 'loadAccount')
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ balances: [{ asset_type: 'native', balance: '9' }] } as never);

    await expect(client.getBalance(ALICE)).resolves.toBe('9');
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a 404 without spending the retry budget', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    const loadAccount = jest
      .spyOn(client.getServer(), 'loadAccount')
      .mockRejectedValue({ response: { status: 404 } });

    await expect(client.getBalance(ALICE)).rejects.toMatchObject({
      code: 'BALANCE_FETCH_ERROR',
    });
    expect(loadAccount).toHaveBeenCalledTimes(1);
  });

  it('honours a per-client retry: { retries: 0 }', async () => {
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: { retries: 0, retryDelayMs: 1, maxRetryDelayMs: 1 },
    });
    const loadAccount = jest
      .spyOn(client.getServer(), 'loadAccount')
      .mockRejectedValue(new Error('down'));

    await expect(client.getBalance(ALICE)).rejects.toMatchObject({
      code: 'BALANCE_FETCH_ERROR',
    });
    expect(loadAccount).toHaveBeenCalledTimes(1);
  });

  it('surfaces TIMEOUT when the client-wide timeoutMs deadline fires', async () => {
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: { retries: 0, retryDelayMs: 1, maxRetryDelayMs: 1 },
      timeoutMs: 1,
    });
    // A loadAccount that never resolves: without the timeout the call would
    // hang the test forever.
    const loadAccount = jest
      .spyOn(client.getServer(), 'loadAccount')
      .mockImplementation(() => new Promise(() => {}));

    await expect(client.getBalance(ALICE)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(loadAccount).toHaveBeenCalledTimes(1);
  });
});

describe('TrustFlowClient.connect retry behaviour', () => {
  /**
   * `server.ledgers()` returns a fresh call builder on every invocation, so the
   * stub is swapped in at the server level rather than by spying on one builder.
   */
  function stubLedgers(client: TrustFlowClient, call: jest.Mock): void {
    jest.spyOn(client, 'getServer').mockReturnValue({
      ledgers: () => ({ limit: () => ({ call }) }),
    } as unknown as ReturnType<TrustFlowClient['getServer']>);
    jest.spyOn(client, 'getSorobanServer').mockReturnValue({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    } as unknown as ReturnType<TrustFlowClient['getSorobanServer']>);
  }

  it('retries a transient ledger lookup and then connects', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    const call = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('failed to fetch'))
      .mockResolvedValueOnce({ records: [] });
    stubLedgers(client, call);

    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('surfaces CONNECTION_ERROR once the retry budget is spent', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    stubLedgers(client, jest.fn().mockRejectedValue(new Error('down')));

    await expect(client.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    expect(client.isConnected()).toBe(false);
  });

  it('fails fast on a deterministic 4xx without retrying', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    const call = jest.fn().mockRejectedValue({ response: { status: 403 } });
    stubLedgers(client, call);

    await expect(client.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('rejects startup when Soroban RPC is reachable but unhealthy', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    stubLedgers(client, jest.fn().mockResolvedValue({ records: [] }));
    jest.spyOn(client, 'getSorobanServer').mockReturnValue({
      getHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
    } as unknown as ReturnType<TrustFlowClient['getSorobanServer']>);

    await expect(client.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    expect(client.isConnected()).toBe(false);
  });

  it('rejects startup when Soroban RPC health cannot be reached', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT, retry: FAST });
    stubLedgers(client, jest.fn().mockResolvedValue({ records: [] }));
    const getHealth = jest.fn().mockRejectedValue(new TypeError('failed to fetch'));
    jest.spyOn(client, 'getSorobanServer').mockReturnValue({
      getHealth,
    } as unknown as ReturnType<TrustFlowClient['getSorobanServer']>);

    await expect(client.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    expect(getHealth).toHaveBeenCalledTimes(3);
    expect(client.isConnected()).toBe(false);
  });

  it('surfaces TIMEOUT when the client-wide timeoutMs deadline fires', async () => {
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: { retries: 0, retryDelayMs: 1, maxRetryDelayMs: 1 },
      timeoutMs: 1,
    });
    // A ledger lookup that never resolves: without the timeout the call would
    // hang the test forever.
    stubLedgers(client, jest.fn().mockImplementation(() => new Promise(() => {})));

    await expect(client.connect()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(client.isConnected()).toBe(false);
  });
});

describe('TrustFlowClient.getAccountInfo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the active account state', async () => {
    const fetchMock = jest.fn().mockResolvedValue(respond(200, accountPayload('5', '99')));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    await expect(client.getAccountInfo()).resolves.toEqual({
      address: ALICE,
      balanceXLM: '5',
      sequenceNumber: '99',
      isActive: true,
    });
  });

  it('throws ACCOUNT_NOT_FOUND when no account is configured', async () => {
    const client = new TrustFlowClient({ contractId: CONTRACT });
    await expect(client.getAccountInfo()).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('does not report a Horizon outage as an unfunded account', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('failed to fetch'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    await expect(client.getAccountInfo()).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });

  it('reports a 404 as an inactive account', async () => {
    const fetchMock = jest.fn().mockResolvedValue(respond(404, {}));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    await expect(client.getAccountInfo()).resolves.toMatchObject({ isActive: false });
  });
});

describe('TrustFlowClient retry configuration surface', () => {
  it('exposes the configured retry budget through getConfig', () => {
    const retry = { retries: 5, retryDelayMs: 100, maxRetryDelayMs: 9000 };
    const client = new TrustFlowClient({ contractId: CONTRACT, retry });
    expect(client.retryConfig).toEqual(retry);
    expect(client.getConfig().retry).toEqual(retry);
  });

  it('is undefined when no retry block is configured', () => {
    const client = new TrustFlowClient({ contractId: CONTRACT });
    expect(client.retryConfig).toBeUndefined();
    expect(client.getConfig().retry).toBeUndefined();
  });

  it('lets an IPFSConfig.retry block supply the client budget', () => {
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      ipfs: { retry: { retries: 1, retryDelayMs: 10, maxRetryDelayMs: 20 } },
    });
    expect(client.retryConfig).toEqual({ retries: 1, retryDelayMs: 10, maxRetryDelayMs: 20 });
  });
});

describe('TrustFlowClient environment reporting', () => {
  it('surfaces the environment report and delegates the WebCrypto assertion', () => {
    const client = new TrustFlowClient({ contractId: CONTRACT });
    const report = client.getEnvironment();
    expect(report.features.length).toBeGreaterThan(0);
    expect(typeof report.supported).toBe('boolean');
    expect(() => client.assertCryptoSupport('test')).not.toThrow();
  });

  it('throws a clear error when WebCrypto is unavailable', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = globals.crypto;
    delete globals.crypto;
    try {
      const client = new TrustFlowClient({ contractId: CONTRACT });
      expect(() => client.assertCryptoSupport('signing')).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_ENVIRONMENT' }),
      );
    } finally {
      globals.crypto = original;
    }
  });
});

describe('TrustFlowError.accountNotFound', () => {
  it('names the ref and points at the fix', () => {
    const err = TrustFlowError.accountNotFound('bob');
    expect(err.code).toBe('ACCOUNT_NOT_FOUND');
    expect(err.message).toContain('"bob"');
    expect(err.message).toContain('client.accounts.add()');

    expect(TrustFlowError.accountNotFound().message).toContain('client.useAccount(id)');
  });
});
