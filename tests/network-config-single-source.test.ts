import { NETWORKS, NETWORK_CONFIGS, getNetworkConfig } from '../src/stellar/network';
import { HORIZON_URLS, SOROBAN_RPC_URLS, NETWORK_PASSPHRASES } from '../src/constants';
import { TrustFlowClient } from '../src/client';
import type { Network } from '../src/types';

const NETWORK_NAMES: Network[] = ['TESTNET', 'MAINNET', 'FUTURENET', 'LOCALNET'];

/**
 * #109 — network URLs and passphrases are defined exactly once
 * (`NETWORKS`); `src/constants.ts` and `TrustFlowClient` must resolve to
 * the same values by construction.
 */
describe('single-source network config (#109)', () => {
  it('constants derive from NETWORKS', () => {
    for (const network of NETWORK_NAMES) {
      expect(HORIZON_URLS[network]).toBe(NETWORKS[network].horizonUrl);
      expect(SOROBAN_RPC_URLS[network]).toBe(NETWORKS[network].rpcUrl);
      expect(NETWORK_PASSPHRASES[network]).toBe(NETWORKS[network].passphrase);
    }
    expect(NETWORK_CONFIGS).toBe(NETWORKS);
  });

  it('TrustFlowClient.getNetworkPassphrase() reads from the same source', () => {
    for (const network of NETWORK_NAMES) {
      const client = new TrustFlowClient({
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        network,
      });
      expect(client.getNetworkPassphrase()).toBe(NETWORKS[network].passphrase);
    }
  });

  it('getNetworkConfig returns the canonical entry', () => {
    for (const network of NETWORK_NAMES) {
      expect(getNetworkConfig(network)).toBe(NETWORKS[network]);
    }
  });

  it('the two networks have distinct, non-empty passphrases', () => {
    expect(NETWORKS.TESTNET.passphrase).not.toBe(NETWORKS.MAINNET.passphrase);
    for (const network of NETWORK_NAMES) {
      expect(NETWORKS[network].passphrase.length).toBeGreaterThan(0);
    }
  });

  it('includes official endpoint and passphrase presets for all four networks', () => {
    expect(NETWORKS.FUTURENET).toEqual({
      horizonUrl: 'https://horizon-futurenet.stellar.org',
      rpcUrl: 'https://rpc-futurenet.stellar.org',
      passphrase: 'Test SDF Future Network ; October 2022',
    });
    expect(NETWORKS.LOCALNET).toEqual({
      horizonUrl: 'http://localhost:8000',
      rpcUrl: 'http://localhost:8000/rpc',
      passphrase: 'Standalone Network ; February 2017',
    });
  });

  it('switches an active client to preset endpoints and invalidates cached connections', () => {
    const client = new TrustFlowClient({ contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' });
    const originalRpcServer = client.getSorobanServer();

    client.switchNetwork('LOCALNET');

    expect(client.network).toBe('LOCALNET');
    expect(client.rpcUrl).toBe(NETWORKS.LOCALNET.rpcUrl);
    expect(client.horizonUrl).toBe(NETWORKS.LOCALNET.horizonUrl);
    expect(client.getNetworkPassphrase()).toBe(NETWORKS.LOCALNET.passphrase);
    expect(client.isConnected()).toBe(false);
    expect(client.getSorobanServer()).not.toBe(originalRpcServer);
  });
});
