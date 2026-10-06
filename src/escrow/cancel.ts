import type { TrustFlowClient } from '../client';
import { TrustFlowError } from '../errors';

/**
 * Cancels an escrow on behalf of `caller`.
 *
 * Only the escrow's sender or an arbitrator may cancel; that authorization is
 * enforced by the contract itself.
 *
 * @param _client - Configured {@link TrustFlowClient}, reserved for the
 * contract call once a live signer is wired in
 * @param escrowId - Identifier of the escrow to cancel
 * @param caller - Address requesting the cancellation
 * @returns A cancellation transaction identifier. This is currently a locally
 * generated placeholder, not an on-chain hash, until the call is wired to a
 * signer.
 * @throws {TrustFlowError} `VALIDATION_ERROR` if `escrowId` is missing, or
 * `UNAUTHORIZED` if `caller` is missing
 *
 * @example
 * ```typescript
 * const txId = await cancelEscrow(client, escrow.id, senderAddress);
 * console.log('Cancellation submitted:', txId);
 * ```
 */
export async function cancelEscrow(
  _client: TrustFlowClient,
  escrowId: string,
  caller: string,
): Promise<string> {
  if (!escrowId) {
    throw TrustFlowError.validation('escrowId', 'Required');
  }
  if (!caller) {
    throw TrustFlowError.unauthorized('cancel');
  }

  // Only sender or arbitrator may cancel
  return `tx_cancel_${escrowId}_${Date.now()}`;
}

/**
 * Fetches a single escrow's on-chain state via the contract's `get_escrow` read.
 *
 * @param _client - Configured {@link TrustFlowClient}, reserved for the Soroban
 * read call once it is wired in
 * @param escrowId - Identifier of the escrow to fetch
 * @returns The escrow record, or `null` while the read call is unimplemented
 * @throws {TrustFlowError} `NOT_FOUND` if `escrowId` is missing
 *
 * @example
 * ```typescript
 * const escrow = await getEscrow(client, escrowId);
 * if (escrow === null) console.log('No escrow data available yet');
 * ```
 */
export async function getEscrow(_client: TrustFlowClient, escrowId: string): Promise<unknown> {
  if (!escrowId) {
    throw TrustFlowError.notFound('Escrow');
  }

  // Soroban read call: get_escrow(escrow_id)
  return null;
}
