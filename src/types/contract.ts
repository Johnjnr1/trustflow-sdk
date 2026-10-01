import type { HttpInterceptors } from '../utils/interceptors';
import type { StellarNetwork } from '../stellar/network';

export interface ContractConfig {
  contractId: string;
  network: StellarNetwork;
  rpcUrl: string;
  networkPassphrase: string;
  apiBaseUrl?: string;
  apiKey?: string;
  /**
   * Client-wide per-request timeout in milliseconds for backend API calls,
   * used when a client's own options do not set one. Defaults to 10s.
   */
  timeoutMs?: number;
  /** Request/response interceptor hooks applied to backend API calls. */
  interceptors?: HttpInterceptors;
}

export interface InvokeContractParams {
  method: string;
  args: unknown[];
  source: string;
  fee?: number;
}

export interface ContractCallResult {
  success: boolean;
  returnValue?: unknown;
  txHash?: string;
  errorCode?: number;
  gasUsed?: number;
  /** Error message when `success` is false, describing why the call failed. */
  error?: string;
}
