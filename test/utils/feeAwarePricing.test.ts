import { describe, it, expect } from 'vitest';
import { TICK_SIZE_STANDARD } from '../../src/utils/conversions';
import {
  getTotalFeeBps,
  minBuyTickToCross,
  maxSellTickToCross,
  applyTakerFeeBuffer,
  estimateBuyFromShares,
  estimateBuyFromAmount,
  estimateSellFromShares,
  OPERATOR_FEE_BPS,
} from '../../src/utils/feeAwarePricing';

const TICK = TICK_SIZE_STANDARD; // 1% ticks -> 100 ticks per dollar

describe('getTotalFeeBps', () => {
  it('sums protocol + venue + operator (default 10 bps)', () => {
    expect(getTotalFeeBps({ protocolFeeBps: 20n, venueFeeBps: 100n })).toBe(130n);
  });

  it('honours overridden operatorFeeBps', () => {
    expect(getTotalFeeBps({ protocolFeeBps: 20n, venueFeeBps: 100n, operatorFeeBps: 0n })).toBe(120n);
  });

  it('exports the on-chain operator constant', () => {
    expect(OPERATOR_FEE_BPS).toBe(10n);
  });
});

describe('minBuyTickToCross — mint-fill path (user-reported regression)', () => {
  // Reproduces the reported bug: Up @47¢ + Down @53¢ does NOT cross because
  // total fees (30 bps assumed: protocol 20 + venue 0 + operator 10) require
  // the two bids to sum strictly above 100¢.
  it('bumps Up bid above 47¢ when Down resting at 53¢ and feeBps=30', () => {
    const result = minBuyTickToCross({
      sameOutcomeAskTick: null,
      oppositeOutcomeBidTick: 53n,
      tickSize: TICK,
      feeBps: 30n,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe('mint');
    // 100 * (1 + 0.0030) = 100.30 → ceil = 101; 101 - 53 = 48
    expect(result!.tick).toBe(48n);
    expect(result!.price).toBe('0.48');
  });

  it('returns null when no liquidity exists', () => {
    expect(
      minBuyTickToCross({
        sameOutcomeAskTick: null,
        oppositeOutcomeBidTick: null,
        tickSize: TICK,
        feeBps: 30n,
      }),
    ).toBeNull();
  });

  it('prefers the cheaper of normal vs mint path', () => {
    // Same-outcome ask at 50¢ (normal cross at 51¢ with 30bps),
    // opposite bid at 60¢ (mint cross at 41¢) — mint is cheaper.
    const result = minBuyTickToCross({
      sameOutcomeAskTick: 50n,
      oppositeOutcomeBidTick: 60n,
      tickSize: TICK,
      feeBps: 30n,
    });
    expect(result!.path).toBe('mint');
    expect(result!.tick).toBe(41n);
  });

  it('uses normal path when same-outcome ask is cheaper', () => {
    const result = minBuyTickToCross({
      sameOutcomeAskTick: 40n,
      oppositeOutcomeBidTick: 30n,
      tickSize: TICK,
      feeBps: 30n,
    });
    expect(result!.path).toBe('normal');
    // 40 * 1.003 = 40.12 → ceil = 41
    expect(result!.tick).toBe(41n);
  });
});

describe('maxSellTickToCross — merge-fill path', () => {
  it('caps Up ask below (100 - oppositeAsk - feeBps) for merge cross', () => {
    // Down ask at 53¢, feeBps=30 → maxMergeTotalTicks = floor(100 * 9970 / 10000) = 99
    // Merge limit for Up = 99 - 53 = 46
    const result = maxSellTickToCross({
      sameOutcomeBidTick: null,
      oppositeOutcomeAskTick: 53n,
      tickSize: TICK,
      feeBps: 30n,
    });
    expect(result!.path).toBe('merge');
    expect(result!.tick).toBe(46n);
  });

  it('prefers the higher of normal vs merge sell tick', () => {
    // Same-outcome bid at 60¢ (normal cross at 60¢),
    // opposite ask at 30¢ → merge cross at 99 - 30 = 69¢ — merge is higher.
    const result = maxSellTickToCross({
      sameOutcomeBidTick: 60n,
      oppositeOutcomeAskTick: 30n,
      tickSize: TICK,
      feeBps: 30n,
    });
    expect(result!.path).toBe('merge');
    expect(result!.tick).toBe(69n);
  });
});

describe('applyTakerFeeBuffer', () => {
  it('rounds the ask up by total fee bps', () => {
    expect(applyTakerFeeBuffer(50n, 30n, TICK)).toBe(51n);
  });

  it('clamps at full price', () => {
    expect(applyTakerFeeBuffer(100n, 30n, TICK)).toBe(100n);
  });
});

describe('estimateBuyFromShares', () => {
  it('computes cost / payout / profit / avgPrice', () => {
    const est = estimateBuyFromShares(100, 0.4);
    expect(est.cost).toBeCloseTo(40);
    expect(est.payout).toBeCloseTo(100);
    expect(est.profit).toBeCloseTo(60);
    expect(est.avgPrice).toBe(0.4);
  });
});

describe('estimateBuyFromAmount', () => {
  it("matches the Polymarket-style screenshot at ~10¢", () => {
    // amount ≈ $11.56 at 10¢ avg price → ~$104 profit (Polymarket "To Win")
    const est = estimateBuyFromAmount(11.56, 0.1);
    expect(est.shares).toBeCloseTo(115.6, 1);
    expect(est.payout).toBeCloseTo(115.6, 1);
    expect(est.profit).toBeCloseTo(104.04, 1);
    expect(est.avgPrice).toBe(0.1);
  });

  it('returns zeroed estimate when price is zero', () => {
    const est = estimateBuyFromAmount(50, 0);
    expect(est.shares).toBe(0);
    expect(est.payout).toBe(0);
    expect(est.profit).toBe(-50);
  });
});

describe('estimateSellFromShares', () => {
  it('multiplies shares by the fee-net price', () => {
    const est = estimateSellFromShares(100, 0.5297); // 0.53 × (1 - 0.0030 ≈ 0.0030)
    expect(est.proceeds).toBeCloseTo(52.97);
  });
});
