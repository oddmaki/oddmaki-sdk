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

/**
 * Recommended UMA Oracle defaults for USDC venues (6 decimals).
 * Based on Polymarket's production configuration.
 */
export const UMA_DEFAULTS = {
  /** Recommended reward: 5 USDC. Incentivizes third-party resolution. */
  REWARD_USDC: 5_000_000n,
  /** Recommended minimum bond: 750 USDC. Matches Polymarket's production bond. */
  MIN_BOND_USDC: 750_000_000n,
  /** Default liveness period: 2 hours (7200 seconds). */
  LIVENESS: 7200n,
} as const;
