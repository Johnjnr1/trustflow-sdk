export type StellarNetwork = 'TESTNET' | 'MAINNET' | 'FUTURENET' | 'LOCALNET';

export interface StellarNetworkConfig {
  horizonUrl: string;
  rpcUrl: string;
  passphrase: string;
}

export const NETWORKS: Record<StellarNetwork, StellarNetworkConfig> = {
  MAINNET: {
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://soroban.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
  },
  TESTNET: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  FUTURENET: {
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    passphrase: 'Test SDF Future Network ; October 2022',
  },
  LOCALNET: {
    horizonUrl: 'http://localhost:8000',
    rpcUrl: 'http://localhost:8000/rpc',
    passphrase: 'Standalone Network ; February 2017',
  },
};

/** @deprecated Use {@link NETWORKS}; retained as the original canonical name. */
export const NETWORK_CONFIGS = NETWORKS;

export function getNetworkConfig(network: StellarNetwork) {
  return NETWORKS[network];
}
