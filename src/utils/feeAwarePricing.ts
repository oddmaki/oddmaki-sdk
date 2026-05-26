/**
 * Fee-aware pricing helpers.
 *
 * The matching engine's mint-to-fill / merge-to-fill paths require bids/asks to
 * cover 1.0 PLUS total fees (protocol + venue + operator). Normal fills also
 * require taker buyers to bid at ask × (1 + totalFeeBps/10_000) for the full
 * quantity to fill (otherwise qty is reduced to whatever the taker's deposit
 * actually covers).
 *
 * These helpers compute the limit price a UI should pre-fill / display so that
 * an order placed at the displayed tick will actually cross now.
 */

import { tickToPrice } from './conversions';

export const BPS_DENOMINATOR = 10000n;

/** Operator fee is a protocol constant, not stored per-market. */
export const OPERATOR_FEE_BPS = 10n;

export interface MarketFeeBps {
  protocolFeeBps: bigint;
  venueFeeBps: bigint;
  /** Defaults to {@link OPERATOR_FEE_BPS} when omitted. */
  operatorFeeBps?: bigint;
}

export function getTotalFeeBps(fees: MarketFeeBps): bigint {
  return fees.protocolFeeBps + fees.venueFeeBps + (fees.operatorFeeBps ?? OPERATOR_FEE_BPS);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function fullPriceTicks(tickSize: bigint): bigint {
  return 10n ** 18n / tickSize;
}

export interface FeeAwarePriceResult {
  tick: bigint;
  /** Decimal price string (e.g. "0.48"). */
  price: string;
  /** Which settlement path produced this crossing tick. */
  path: 'normal' | 'mint' | 'merge';
}

/**
 * Minimum BUY limit price that will fully cross right now.
 *
 * Considers both:
 *  - Normal fill against same-outcome ask: limit ≥ ask × (1 + feeBps/10_000)
 *  - Mint fill against opposite-outcome bid: limit + oppositeBid ≥ 1 × (1 + feeBps/10_000)
 *
 * Returns the cheaper of the two (rounded up to the nearest tick), or `null`
 * when there is no crossable liquidity at any feasible price.
 */
export function minBuyTickToCross(params: {
  sameOutcomeAskTick: bigint | null;
  oppositeOutcomeBidTick: bigint | null;
  tickSize: bigint;
  feeBps: bigint;
}): FeeAwarePriceResult | null {
  const fullTicks = fullPriceTicks(params.tickSize);
  const minTotalTicks = ceilDiv(fullTicks * (BPS_DENOMINATOR + params.feeBps), BPS_DENOMINATOR);

  let best: FeeAwarePriceResult | null = null;

  if (params.sameOutcomeAskTick && params.sameOutcomeAskTick > 0n) {
    const tick = ceilDiv(
      params.sameOutcomeAskTick * (BPS_DENOMINATOR + params.feeBps),
      BPS_DENOMINATOR,
    );
    if (tick > 0n && tick <= fullTicks) {
      best = { tick, price: tickToPrice(tick, params.tickSize), path: 'normal' };
    }
  }

  if (params.oppositeOutcomeBidTick && params.oppositeOutcomeBidTick > 0n) {
    if (params.oppositeOutcomeBidTick < minTotalTicks) {
      const tick = minTotalTicks - params.oppositeOutcomeBidTick;
      if (tick > 0n && tick <= fullTicks) {
        if (!best || tick < best.tick) {
          best = { tick, price: tickToPrice(tick, params.tickSize), path: 'mint' };
        }
      }
    }
  }

  return best;
}

/**
 * Maximum SELL limit price that will fully cross right now.
 *
 * Considers both:
 *  - Normal fill against same-outcome bid: limit ≤ sameOutcomeBid
 *    (no fee adjustment — fees come out of seller's proceeds, not the limit)
 *  - Merge fill against opposite-outcome ask: limit + oppositeAsk ≤ 1 × (1 - feeBps/10_000)
 *
 * Returns the higher of the two (the most favourable sell limit that still
 * crosses), or `null` when no crossable liquidity exists.
 */
export function maxSellTickToCross(params: {
  sameOutcomeBidTick: bigint | null;
  oppositeOutcomeAskTick: bigint | null;
  tickSize: bigint;
  feeBps: bigint;
}): FeeAwarePriceResult | null {
  const fullTicks = fullPriceTicks(params.tickSize);
  const maxMergeTotalTicks = (fullTicks * (BPS_DENOMINATOR - params.feeBps)) / BPS_DENOMINATOR;

  let best: FeeAwarePriceResult | null = null;

  if (params.sameOutcomeBidTick && params.sameOutcomeBidTick > 0n) {
    const tick = params.sameOutcomeBidTick;
    best = { tick, price: tickToPrice(tick, params.tickSize), path: 'normal' };
  }

  if (params.oppositeOutcomeAskTick && params.oppositeOutcomeAskTick > 0n) {
    if (maxMergeTotalTicks > params.oppositeOutcomeAskTick) {
      const tick = maxMergeTotalTicks - params.oppositeOutcomeAskTick;
      if (tick > 0n && (!best || tick > best.tick)) {
        best = { tick, price: tickToPrice(tick, params.tickSize), path: 'merge' };
      }
    }
  }

  return best;
}

/**
 * Bump a BUY taker's limit to cover total fees on a normal fill.
 *
 * The matching engine reduces a taker BUY's qty whenever
 * `limit < ask × (1 + totalFeeBps/10_000)`. For a market BUY UI that already
 * applies a slippage % on top of best ask, callers typically want to *also*
 * include the fee bump so the user never silently partial-fills.
 */
export function applyTakerFeeBuffer(askTick: bigint, feeBps: bigint, tickSize: bigint): bigint {
  const fullTicks = fullPriceTicks(tickSize);
  const tick = ceilDiv(askTick * (BPS_DENOMINATOR + feeBps), BPS_DENOMINATOR);
  return tick > fullTicks ? fullTicks : tick;
}

// ============================================================================
// Outcome payout estimation ("To Win" math)
// ============================================================================

/**
 * Estimate of a BUY's economics, in human-readable units.
 *
 * `pricePerShare` is expected to be the **fee-inclusive effective price** the
 * user actually pays per share (i.e. raw ask × (1 + totalFeeBps/10_000) for a
 * normal-fill taker, or the limit tick for a passive maker order). All other
 * fields fall out of that.
 */
export interface BuyOutcomeEstimate {
  /** Shares acquired. */
  shares: number;
  /** Total spent (cost basis). */
  cost: number;
  /** Total dollars received if the outcome wins (= shares, since each pays $1). */
  payout: number;
  /** Profit if the outcome wins (payout − cost). Polymarket's "To Win". */
  profit: number;
  /** Effective average price per share (the input). */
  avgPrice: number;
}

/** Estimate from a known shares quantity and per-share price. */
export function estimateBuyFromShares(shares: number, pricePerShare: number): BuyOutcomeEstimate {
  const safeShares = Math.max(0, Number.isFinite(shares) ? shares : 0);
  const safePrice = Math.max(0, Number.isFinite(pricePerShare) ? pricePerShare : 0);
  const cost = safeShares * safePrice;
  const payout = safeShares; // 1 share -> $1 on win
  return {
    shares: safeShares,
    cost,
    payout,
    profit: payout - cost,
    avgPrice: safePrice,
  };
}

/** Estimate from a dollar amount and a fee-inclusive avg price per share. */
export function estimateBuyFromAmount(amount: number, pricePerShare: number): BuyOutcomeEstimate {
  const safeAmount = Math.max(0, Number.isFinite(amount) ? amount : 0);
  const safePrice = Math.max(0, Number.isFinite(pricePerShare) ? pricePerShare : 0);
  if (safePrice <= 0) {
    return { shares: 0, cost: safeAmount, payout: 0, profit: -safeAmount, avgPrice: 0 };
  }
  const shares = safeAmount / safePrice;
  return {
    shares,
    cost: safeAmount,
    payout: shares,
    profit: shares - safeAmount,
    avgPrice: safePrice,
  };
}

/**
 * Estimate of a SELL's net proceeds.
 *
 * `pricePerShare` should be the **fee-inclusive net** the seller receives per
 * share (i.e. raw bid × (1 − totalFeeBps/10_000) when the seller is the taker).
 */
export interface SellOutcomeEstimate {
  shares: number;
  /** Effective net price per share. */
  avgPrice: number;
  /** Dollars the seller receives (= shares × avgPrice). */
  proceeds: number;
}

export function estimateSellFromShares(shares: number, pricePerShare: number): SellOutcomeEstimate {
  const safeShares = Math.max(0, Number.isFinite(shares) ? shares : 0);
  const safePrice = Math.max(0, Number.isFinite(pricePerShare) ? pricePerShare : 0);
  return {
    shares: safeShares,
    avgPrice: safePrice,
    proceeds: safeShares * safePrice,
  };
}
