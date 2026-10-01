import type { Network } from './types';
import { NETWORK_CONFIGS } from './stellar/network';

export const DEFAULT_NETWORK: Network = 'TESTNET';

/**
 * URLs and passphrases are a *view* of `NETWORK_CONFIGS`
 * (`src/stellar/network.ts`) — the single canonical network-config source
 * (#109) — not a second copy of the literals.
 */
export const HORIZON_URLS: Record<Network, string> = {
  TESTNET: NETWORK_CONFIGS.TESTNET.horizonUrl,
  MAINNET: NETWORK_CONFIGS.MAINNET.horizonUrl,
  FUTURENET: NETWORK_CONFIGS.FUTURENET.horizonUrl,
  LOCALNET: NETWORK_CONFIGS.LOCALNET.horizonUrl,
};

export const SOROBAN_RPC_URLS: Record<Network, string> = {
  TESTNET: NETWORK_CONFIGS.TESTNET.rpcUrl,
  MAINNET: NETWORK_CONFIGS.MAINNET.rpcUrl,
  FUTURENET: NETWORK_CONFIGS.FUTURENET.rpcUrl,
  LOCALNET: NETWORK_CONFIGS.LOCALNET.rpcUrl,
};

export const NETWORK_PASSPHRASES: Record<Network, string> = {
  TESTNET: NETWORK_CONFIGS.TESTNET.passphrase,
  MAINNET: NETWORK_CONFIGS.MAINNET.passphrase,
  FUTURENET: NETWORK_CONFIGS.FUTURENET.passphrase,
  LOCALNET: NETWORK_CONFIGS.LOCALNET.passphrase,
};

export const ESCROW_MIN_AMOUNT_STROOPS = 1_000_000n; // 0.1 XLM
export const ESCROW_MAX_DURATION_BLOCKS = 1_000_000;
export const SDK_VERSION = '0.2.1';
export const DEFAULT_API_VERSION = '1.0.0';
export const API_VERSION_HEADER = 'X-API-Version';
export const SDK_VERSION_HEADER = 'X-SDK-Version';
