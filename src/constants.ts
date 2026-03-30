/**
 * Protocol Constants
 * These values match the on-chain constants defined in the smart contracts.
 */

/**
 * Fee Constants
 * Fixed protocol-level fee tiers (not configurable per-market)
 */
export const PROTOCOL_FEES = {
  /** Protocol fee: 20 bps (0.20%) */
  PROTOCOL_FEE_BPS: 20n,
  /** Operator fee: 10 bps (0.10%) for match operators */
  OPERATOR_FEE_BPS: 10n,
} as const;
