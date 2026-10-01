/**
 * Zod runtime validation schemas for TrustFlow SDK (#45, #214, #233).
 *
 * These are the same schemas the SDK uses internally to validate inputs
 * before building contract calls. They are exported from the package root
 * so consumers (including frontend form/validation code) can reuse them
 * directly instead of re-implementing the same rules, e.g.:
 *
 * ```typescript
 * import { CreateEscrowSchema } from '@trustflow/sdk';
 *
 * const result = CreateEscrowSchema.safeParse(formValues);
 * if (!result.success) {
 *   showFormErrors(result.error.flatten());
 * }
 * ```
 */
import { z } from 'zod';
import { TrustFlowError } from './errors';
import { STELLAR_ADDRESS_RE, CONTRACT_ID_RE } from './utils/validation';
import { isValidCid } from './storage/cid';

// ── Primitives ────────────────────────────────────────────────────────────────

/** Validates a Stellar account address (`G...`, 56 chars, base32). */
export const StellarAddressSchema = z
  .string()
  .regex(STELLAR_ADDRESS_RE, 'Invalid Stellar address (must start with G and be 56 chars)');

/** Validates a Soroban contract ID (`C...`, 56 chars, base32). */
export const ContractIdSchema = z
  .string()
  .regex(CONTRACT_ID_RE, 'Invalid contract ID (must start with C and be 56 chars)');

/** Validates a positive amount denominated in stroops (1 XLM = 10,000,000 stroops). */
export const StroopsSchema = z.bigint().positive('Amount must be positive');

/** Validates a supported TrustFlow network name. */
export const NetworkSchema = z.enum(['MAINNET', 'TESTNET', 'FUTURENET', 'LOCALNET']);

/** Validates a CID string (CIDv0 or CIDv1). */
export const CidSchema = z.string().refine(isValidCid, {
  message: 'Invalid CID (must be a valid CIDv0 or CIDv1 string)',
});

// ── Escrow ────────────────────────────────────────────────────────────────────

/** Validates the input to `escrow.create()`. */
export const CreateEscrowSchema = z.object({
  sender: StellarAddressSchema,
  recipient: StellarAddressSchema,
  amount: StroopsSchema,
  durationBlocks: z.number().int().nonnegative().optional(),
  network: NetworkSchema.default('TESTNET'),
  memo: z.string().max(28).optional(),
});

/** Validates the input to `escrow.release()`. */
export const ReleaseEscrowSchema = z.object({
  escrowId: z.string().min(1),
  recipient: StellarAddressSchema,
  network: NetworkSchema.default('TESTNET'),
});

/** Validates the input to `escrow.dispute()`. */
export const DisputeEscrowSchema = z.object({
  escrowId: z.string().min(1),
  reason: z.string().min(10, 'Dispute reason must be at least 10 characters'),
  evidence: z
    .string()
    .refine(
      (val) => {
        if (!val) return true;
        if (isValidCid(val)) return true;
        if (val.startsWith('ipfs://')) {
          const stripped = val.slice('ipfs://'.length);
          return isValidCid(stripped);
        }
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Evidence must be a valid URL, IPFS URI, or CID' },
    )
    .optional(),
  network: NetworkSchema.default('TESTNET'),
});

// ── Client config ─────────────────────────────────────────────────────────────

/** Validates the config object passed to `new TrustFlowClient(...)`. */
export const ClientConfigSchema = z.object({
  network: NetworkSchema.default('TESTNET'),
  contractId: ContractIdSchema,
  rpcUrl: z.string().url('RPC URL must be a valid URL').optional(),
  horizonUrl: z.string().url('Horizon URL must be a valid URL').optional(),
  networkPassphrase: z
    .string()
    .refine((value) => value.trim().length > 0, 'Network passphrase must not be empty')
    .optional(),
  apiBaseUrl: z.string().url('API base URL must be a valid URL').optional(),
  apiKey: z.string().optional(),
  apiVersion: z.string().optional(),
  balanceCache: z
    .object({
      ttlMs: z.number().positive().optional(),
    })
    .optional(),
  ipfs: z
    .object({
      apiUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
      gatewayUrl: z.string().url().optional(),
      timeoutMs: z.number().positive().optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
      json: z.boolean().optional(),
      // Custom logger instances (pino/winston/...) are accepted as-is.
      logger: z.any().optional(),
    })
    .optional(),
});

// ── Inferred types ────────────────────────────────────────────────────────────

export type CreateEscrowInput = z.infer<typeof CreateEscrowSchema>;
export type ReleaseEscrowInput = z.infer<typeof ReleaseEscrowSchema>;
export type DisputeEscrowInput = z.infer<typeof DisputeEscrowSchema>;
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type StellarAddress = z.infer<typeof StellarAddressSchema>;
export type ContractId = z.infer<typeof ContractIdSchema>;
export type Network = z.infer<typeof NetworkSchema>;

// ── RPC response validation (#72) ────────────────────────────────────────────
//
// Runtime-validates a decoded RPC/Horizon response against a Zod schema and
// throws a typed `TrustFlowError` (code `VALIDATION_ERROR`) with the flattened
// Zod issues attached as `cause` on failure, instead of letting a malformed
// or unexpectedly-shaped response propagate as an untyped runtime error deep
// inside contract-call code.
//
// Usage:
// ```typescript
// const raw = await rpc.getTransaction(hash);
// const tx = parseRpcResponse(GetTransactionResponseSchema, raw, 'getTransaction');
// ```
export function parseRpcResponse<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  context: string,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new TrustFlowError(
      `RPC response for "${context}" failed schema validation`,
      'VALIDATION_ERROR',
      undefined,
      context,
      result.error.issues,
    );
  }
  return result.data;
}
