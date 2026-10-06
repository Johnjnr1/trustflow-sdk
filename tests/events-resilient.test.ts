import {
  fetchContractEvents,
  parseEvent,
  type RawContractEvent,
  type ParsedTrustFlowEvent,
  InMemoryCursorStore,
} from '../src/events';
import { EscrowMonitor, type MonitorGapInfo } from '../src/escrow/monitor';

/** Build a valid XDR `ScVal` for a string value, as Soroban contract events emit. */
function scStr(s: string): string {
  const rawLength = 8 + s.length;
  const paddedLength = rawLength + ((4 - (rawLength % 4)) % 4);
  const buf = Buffer.alloc(paddedLength);
  buf.writeUInt32BE(14, 0); // scvString
  buf.writeUInt32BE(s.length, 4);
  buf.write(s, 8, 'utf8');
  return buf.toString('base64');
}

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

function raw(id: string, pagingToken: string, ledger: number): RawContractEvent {
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId: CONTRACT_ID,
    id,
    pagingToken,
    value: '5000000',
    topic: [scStr('escrow_created'), scStr('esc-1'), scStr('GSENDER'), scStr('GRECIPIENT')],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `cond` holds (avoids fixed-sleep flakiness on loaded machines). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

describe('fetchContractEvents helper', () => {
  it('sends contract-id filter with cursor/startLedger and maps pages', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = {
      getEvents: async (req: Record<string, unknown>) => {
        seen.push(req);
        return {
          events: [raw('ev-1', 'cursor-1', 42)],
          cursor: 'cursor-1',
          latestLedger: 42,
        };
      },
    };
    const page = await fetchContractEvents(server, { contractId: CONTRACT_ID, startLedger: 40 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe('cursor-1');
    expect(page.latestLedger).toBe(42);
    const filters = (seen[0]['filters'] as Array<Record<string, unknown>>)[0];
    expect(filters['contractIds']).toEqual([CONTRACT_ID]);

    const page2 = await fetchContractEvents(server, { contractId: CONTRACT_ID, cursor: 'cursor-1' });
    expect(seen[1]['cursor']).toBe('cursor-1');
    expect(page2.events).toHaveLength(1);
  });

  it('parseEvent carries pagingToken for cursor resumption', () => {
    const parsed = parseEvent(raw('ev-9', 'pt-9', 7));
    expect(parsed?.pagingToken).toBe('pt-9');
    expect(parsed?.id).toBe('ev-9');
  });
});

describe('EscrowMonitor resilient polling', () => {
  it('recovers after transient failures with backoff and dedups across resumes', async () => {
    const monitor = new EscrowMonitor();
    const seen: ParsedTrustFlowEvent[] = [];
    const reconnects: number[] = [];
    monitor.on('escrow_created', (e) => void seen.push(e));
    monitor.onReconnect(({ failures }) => void reconnects.push(failures));

    const e1 = parseEvent(raw('ev-1', 'pt-1', 10))!;
    const e2 = parseEvent(raw('ev-2', 'pt-2', 11))!;
    let calls = 0;
    const fetchFn = async (_cursor?: string): Promise<ParsedTrustFlowEvent[]> => {
      calls += 1;
      // Fail twice so the shared retry helper (attempts: 2) exhausts on the
      // first tick, then succeed — exercising backoff + onReconnect.
      if (calls <= 2) throw new Error('dropped request');
      if (calls === 3) return [e1];
      // Duplicate page: e1 again plus e2 — e1 must not be re-delivered.
      return [e1, e2];
    };

    monitor.startResilientPolling(10, fetchFn, { baseBackoffMs: 5, maxBackoffMs: 20 });
    await waitFor(() => calls >= 4 && reconnects.length >= 1 && seen.length >= 2);
    monitor.stopPolling();

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    const ids = seen.map((e) => e.id);
    expect(ids).toContain('ev-1');
    expect(ids).toContain('ev-2');
    expect(ids.filter((id) => id === 'ev-1')).toHaveLength(1);
  });

  it('persists cursor to the store and resumes without re-delivery', async () => {
    const store = new InMemoryCursorStore();
    const e1 = parseEvent(raw('ev-1', 'pt-1', 20))!;
    const cursorsSeen: Array<string | undefined> = [];
    const monitor = new EscrowMonitor();
    const seen: string[] = [];
    monitor.on('escrow_created', (e) => void seen.push(e.id));

    monitor.startResilientPolling(
      10,
      async (cursor) => {
        cursorsSeen.push(cursor);
        if (cursor === 'pt-1') return [];
        return [e1];
      },
      { store, baseBackoffMs: 5, maxBackoffMs: 10 },
    );
    await waitFor(() => cursorsSeen.length >= 2 && seen.length >= 1);
    monitor.stopPolling();

    expect(await store.get()).toBe('pt-1');
    expect(cursorsSeen[0]).toBeUndefined();
    expect(cursorsSeen.slice(1)).toContain('pt-1');
    expect(seen.filter((id) => id === 'ev-1')).toHaveLength(1);
  });

  it('reports retention gaps when the cursor is too old', async () => {
    const monitor = new EscrowMonitor();
    const gaps: MonitorGapInfo[] = [];
    monitor.onGapDetected((g) => void gaps.push(g));
    monitor.startResilientPolling(
      10,
      async () => {
        throw new Error('cursor older than retention window');
      },
      { baseBackoffMs: 5, maxBackoffMs: 10 },
    );
    await waitFor(() => gaps.length >= 1);
    monitor.stopPolling();
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].reason).toBe('cursor-expired');
  });

  it('detects ledger discontinuities as gaps', async () => {
    const monitor = new EscrowMonitor();
    const gaps: MonitorGapInfo[] = [];
    monitor.onGapDetected((g) => void gaps.push(g));
    let calls = 0;
    monitor.startResilientPolling(
      10,
      async () => {
        calls += 1;
        if (calls === 1) return [parseEvent(raw('ev-1', 'pt-1', 30))!];
        if (calls === 2) return [parseEvent(raw('ev-2', 'pt-2', 35))!];
        return [];
      },
      { baseBackoffMs: 5, maxBackoffMs: 10 },
    );
    await waitFor(() => gaps.length >= 1 && calls >= 2);
    monitor.stopPolling();
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].reason).toBe('ledger-discontinuity');
    expect(gaps[0].fromLedger).toBe(30);
    expect(gaps[0].toLedger).toBe(35);
  });

  it('ignores nullish entries in polling batches without crashing', async () => {
    const monitor = new EscrowMonitor();
    const seen: ParsedTrustFlowEvent[] = [];
    monitor.on('escrow_created', (e) => void seen.push(e));
    monitor.startPolling(10, async () => [
      null,
      parseEvent(raw('ev-x', 'pt-x', 1)),
    ] as Array<ParsedTrustFlowEvent | null>);
    await waitFor(() => seen.length >= 1);
    monitor.stopPolling();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.map((e) => e.id)).toContain('ev-x');
  });

  it('startPolling stays backward compatible (no cursor arg)', async () => {
    const monitor = new EscrowMonitor();
    const seen: ParsedTrustFlowEvent[] = [];
    monitor.on('escrow_created', (e) => void seen.push(e));
    monitor.startPolling(10, async () => [parseEvent(raw('ev-x', 'pt-x', 1))!]);
    await waitFor(() => seen.length >= 1);
    monitor.stopPolling();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});
