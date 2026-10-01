import { TrustFlowClient } from '../src/client';
import { TrustFlowError } from '../src/errors';

describe('TrustFlowClient', () => {
  const mockContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  describe('getSorobanServer', () => {
    it('returns the same cached instance across calls', () => {
      const client = new TrustFlowClient({ contractId: mockContractId });

      expect(client.getSorobanServer()).toBe(client.getSorobanServer());
    });

    it('builds the server from a custom rpcUrl when one is configured', () => {
      const rpcUrl = 'https://custom-rpc.example.com';
      const client = new TrustFlowClient({ contractId: mockContractId, rpcUrl });

      expect(client.getSorobanServer().serverURL.toString()).toContain(
        'custom-rpc.example.com',
      );
    });

    it('falls back to the network default when no rpcUrl is given', () => {
      const client = new TrustFlowClient({ contractId: mockContractId });

      expect(client.getSorobanServer().serverURL.toString()).toContain(
        new URL(client.rpcUrl).host,
      );
    });

    it('gives separate clients their own server instances', () => {
      const a = new TrustFlowClient({ contractId: mockContractId });
      const b = new TrustFlowClient({ contractId: mockContractId });

      expect(a.getSorobanServer()).not.toBe(b.getSorobanServer());
    });
  });

  describe('constructor', () => {
    it('should create client with minimal config', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      expect(client.network).toBe('TESTNET');
      expect(client.contractId).toBe(mockContractId);
      expect(client.version).toBeDefined();
    });

    it('should create client with full config', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        network: 'MAINNET',
        rpcUrl: 'https://custom-rpc.example.com',
        apiBaseUrl: 'https://api.trustflow.xyz',
        apiKey: 'test-key',
      });

      expect(client.network).toBe('MAINNET');
      expect(client.rpcUrl).toBe('https://custom-rpc.example.com');
      expect(client.apiBaseUrl).toBe('https://api.trustflow.xyz');
      expect(client.apiKey).toBe('test-key');
    });

    it('should throw error if contractId is missing', () => {
      expect(() => {
        new TrustFlowClient({} as any);
      }).toThrow(TrustFlowError);
    });
  });

  describe('getConfig', () => {
    it('should return configuration summary', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        network: 'TESTNET',
        apiBaseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      });

      const config = client.getConfig();

      expect(config.network).toBe('TESTNET');
      expect(config.contractId).toBe(mockContractId);
      expect(config.apiConfigured).toBe(true);
      expect(config.version).toBeDefined();
    });

    it('should show apiConfigured as false when not configured', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      const config = client.getConfig();
      expect(config.apiConfigured).toBe(false);
    });
  });

  describe('getBalance caching', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    afterEach(() => {
      jest.useRealTimers();
    });

    function mockBalanceLookup(client: TrustFlowClient, balance = '42.0000000') {
      return jest
        .spyOn(client.getServer(), 'loadAccount')
        .mockResolvedValue({
          balances: [{ asset_type: 'native', balance }],
        } as any);
    }

    it('uses a cached balance within the configured TTL', async () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        balanceCache: { ttlMs: 5_000 },
      });
      const loadAccount = mockBalanceLookup(client);

      await expect(client.getBalance(address)).resolves.toBe('42.0000000');
      await expect(client.getBalance(address)).resolves.toBe('42.0000000');

      expect(loadAccount).toHaveBeenCalledTimes(1);
    });

    it('fetches a new balance after the cache TTL expires', async () => {
      jest.useFakeTimers();
      const client = new TrustFlowClient({
        contractId: mockContractId,
        balanceCache: { ttlMs: 5_000 },
      });
      const loadAccount = mockBalanceLookup(client);

      await client.getBalance(address);
      jest.advanceTimersByTime(5_001);
      await client.getBalance(address);

      expect(loadAccount).toHaveBeenCalledTimes(2);
    });

    it('bypasses a cached balance when skipCache is requested', async () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        balanceCache: {},
      });
      const loadAccount = mockBalanceLookup(client);

      await client.getBalance(address);
      await client.getBalance(address, { skipCache: true });

      expect(loadAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe('getNetworkPassphrase', () => {
    it('should return testnet passphrase', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        network: 'TESTNET',
      });

      expect(client.getNetworkPassphrase()).toContain('Test SDF Network');
    });

    it('should return mainnet passphrase', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        network: 'MAINNET',
      });

      expect(client.getNetworkPassphrase()).toContain('Public Global Stellar Network');
    });

    it('rejects an empty explicit passphrase during initialization', () => {
      expect(() => new TrustFlowClient({
        contractId: mockContractId,
        networkPassphrase: '   ',
      })).toThrow(TrustFlowError);
    });
  });

  describe('getAuthHeaders', () => {
    it('should return headers with SDK version', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      const headers = client.getAuthHeaders();

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-SDK-Version']).toBeDefined();
    });

    it('should include authorization header when apiKey is provided', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
        apiKey: 'test-key-123',
      });

      const headers = client.getAuthHeaders();

      expect(headers['Authorization']).toBe('Bearer test-key-123');
    });

    it('should not include authorization header when apiKey is missing', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      const headers = client.getAuthHeaders();

      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('isConnected', () => {
    it('should return false before connection', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      expect(client.isConnected()).toBe(false);
    });
  });

  describe('ensureConnected', () => {
    it('should throw error if not connected', () => {
      const client = new TrustFlowClient({
        contractId: mockContractId,
      });

      expect(() => client.ensureConnected()).toThrow(TrustFlowError);
      expect(() => client.ensureConnected()).toThrow('not connected');
    });
  });
});
