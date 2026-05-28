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

/**
 * Convert a UI-friendly slippage percent (e.g. 5 or "5.5") into the bps value
 * the on-chain `placeMarketBuy` / `placeMarketSell` selectors expect. Caps at
 * the protocol's `MAX_SLIPPAGE_BPS` (2000 = 20%) to mirror the on-chain bound.
 */
export const MAX_SLIPPAGE_BPS = 2000n;

export function slippagePctToBps(pct: number | string): bigint {
  const n = typeof pct === 'string' ? parseFloat(pct) : pct;
  if (!Number.isFinite(n) || n < 0) return 0n;
  const bps = BigInt(Math.round(n * 100));
  return bps > MAX_SLIPPAGE_BPS ? MAX_SLIPPAGE_BPS : bps;
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

// ============================================================================
// Pre-trade preview for market orders (slippage + fees combined)
// ============================================================================

export interface MarketBuyPreview {
  /** Expected per-share cost in $ (mark price + fees, no slippage applied). */
  expectedPricePerShare: number;
  /** Worst-case per-share cost in $ (mark price + slippage + fees). */
  worstPricePerShare: number;
  /** Shares acquired at the expected price. */
  expectedShares: number;
  /** Shares acquired in the worst case (slippage fully consumed). */
  worstCaseShares: number;
  /** Total payout at the expected shares (= shares × $1). */
  expectedPayout: number;
  /** Profit at the expected shares (= payout − amount). */
  expectedProfit: number;
}

/**
 * UI preview for a market BUY. Given an `amount` to spend, a resolved mark
 * price (e.g. from `getMarkPriceSimple`), the user's `slippagePct`, and the
 * market's total fee bps (= protocol + venue + operator), returns expected /
 * worst-case shares + payout + profit.
 *
 * The contract enforces that no fill happens above
 * `markPrice × (1 + slippagePct/100) × (1 + feeBps/10000)` per share, so the
 * worst-case shares is the lower bound on what the user will receive.
 */
export function previewMarketBuy(params: {
  amount: number;
  markPrice: number;
  slippagePct: number;
  feeBps: number | bigint;
}): MarketBuyPreview {
  const amount = Math.max(0, Number.isFinite(params.amount) ? params.amount : 0);
  const mark = Math.max(0, Number.isFinite(params.markPrice) ? params.markPrice : 0);
  const slipFrac = Math.max(0, Number.isFinite(params.slippagePct) ? params.slippagePct : 0) / 100;
  const feeBpsNum = typeof params.feeBps === 'bigint' ? Number(params.feeBps) : params.feeBps;
  const feeMul = 1 + feeBpsNum / 10_000;

  if (mark <= 0 || amount <= 0) {
    return {
      expectedPricePerShare: 0,
      worstPricePerShare: 0,
      expectedShares: 0,
      worstCaseShares: 0,
      expectedPayout: 0,
      expectedProfit: -amount,
    };
  }

  const expectedPricePerShare = mark * feeMul;
  const worstPricePerShare = mark * (1 + slipFrac) * feeMul;
  const expectedShares = amount / expectedPricePerShare;
  const worstCaseShares = amount / worstPricePerShare;
  const expectedPayout = expectedShares; // 1 share → $1 on win

  return {
    expectedPricePerShare,
    worstPricePerShare,
    expectedShares,
    worstCaseShares,
    expectedPayout,
    expectedProfit: expectedPayout - amount,
  };
}

export interface MarketSellPreview {
  /** Expected per-share payout in $ (mark price − fees). */
  expectedPricePerShare: number;
  /** Worst-case per-share payout in $ (mark × (1 − slip) − fees). */
  worstPricePerShare: number;
  /** Expected total net proceeds. */
  expectedProceeds: number;
  /** Worst-case total net proceeds. */
  worstCaseProceeds: number;
}

/**
 * UI preview for a market SELL. Given `shares` to sell, a resolved mark price,
 * `slippagePct`, and `feeBps`, returns expected / worst-case net proceeds.
 */
export function previewMarketSell(params: {
  shares: number;
  markPrice: number;
  slippagePct: number;
  feeBps: number | bigint;
}): MarketSellPreview {
  const shares = Math.max(0, Number.isFinite(params.shares) ? params.shares : 0);
  const mark = Math.max(0, Number.isFinite(params.markPrice) ? params.markPrice : 0);
  const slipFrac = Math.max(0, Number.isFinite(params.slippagePct) ? params.slippagePct : 0) / 100;
  const feeBpsNum = typeof params.feeBps === 'bigint' ? Number(params.feeBps) : params.feeBps;
  const feeNet = 1 - feeBpsNum / 10_000;

  const expectedPricePerShare = mark * feeNet;
  const worstPricePerShare = mark * (1 - slipFrac) * feeNet;

  return {
    expectedPricePerShare,
    worstPricePerShare,
    expectedProceeds: shares * expectedPricePerShare,
    worstCaseProceeds: shares * Math.max(0, worstPricePerShare),
  };
}
