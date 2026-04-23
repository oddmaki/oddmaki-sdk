import { describe, it, expect } from 'vitest';
import {
  TICK_SIZE_STANDARD,
  TICK_SIZE_FINE,
  isValidTickSize,
  priceToTick,
  tickToPrice,
  parseAmount,
  formatAmount,
  createExpiry,
  tickToPercentage,
  getOutcomePrice,
  calculateChancePercent,
  parseAncillaryData,
  formatAncillaryData,
} from '../../src/utils/conversions';

describe('tick size validation', () => {
  it('accepts 1e16 and 1e15', () => {
    expect(isValidTickSize(TICK_SIZE_STANDARD)).toBe(true);
    expect(isValidTickSize(TICK_SIZE_FINE)).toBe(true);
  });

  it('rejects any other tick size', () => {
    expect(isValidTickSize(0n)).toBe(false);
    expect(isValidTickSize(1n)).toBe(false);
    expect(isValidTickSize(10n ** 17n)).toBe(false);
    expect(isValidTickSize(10n ** 18n)).toBe(false);
  });
});

describe('priceToTick / tickToPrice round-trip', () => {
  // Round-trip across the full standard-tick grid — if this breaks, the
  // orderbook-level pricing is silently wrong.
  it('round-trips every tick 0..100 at the 1% grid', () => {
    for (let tick = 0; tick <= 100; tick++) {
      const priceStr = tickToPrice(BigInt(tick));
      const back = priceToTick(priceStr);
      expect(back).toBe(BigInt(tick));
    }
  });

  it('parses numeric and string price inputs identically', () => {
    expect(priceToTick(0.55)).toBe(priceToTick('0.55'));
    expect(priceToTick(1)).toBe(100n);
    expect(priceToTick('0')).toBe(0n);
  });

  it('rounds sub-tick precision to the nearest tick', () => {
    expect(priceToTick('0.554')).toBe(55n);
    expect(priceToTick('0.555')).toBe(56n);
  });
});

describe('parseAmount / formatAmount round-trip', () => {
  // format only strips trailing zeros in the *decimal* part, so whole-number
  // inputs like "1000000" come back identical.
  it('round-trips at 6 decimals (USDC)', () => {
    for (const c of ['0', '1', '10.5', '100.123456', '1000000']) {
      expect(formatAmount(parseAmount(c, 6), 6)).toBe(c);
    }
  });

  it('round-trips at 18 decimals (ETH)', () => {
    for (const c of ['0', '1', '10.5', '0.000000000000000001']) {
      expect(formatAmount(parseAmount(c, 18), 18)).toBe(c);
    }
  });

  it('truncates decimal places beyond the token decimals', () => {
    // 6-decimal token can't represent 10.1234567 — last digit drops.
    expect(parseAmount('10.1234567', 6)).toBe(parseAmount('10.123456', 6));
  });

  it('handles whole-number inputs with no fractional part', () => {
    expect(parseAmount('100', 6)).toBe(100_000_000n);
    expect(formatAmount(100_000_000n, 6)).toBe('100');
  });
});

describe('createExpiry', () => {
  it('supports s/m/h/d units', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(Number(createExpiry('30s')) - now).toBeCloseTo(30, -1);
    expect(Number(createExpiry('5m')) - now).toBeCloseTo(300, -1);
    expect(Number(createExpiry('2h')) - now).toBeCloseTo(7200, -1);
    expect(Number(createExpiry('1d')) - now).toBeCloseTo(86400, -1);
  });

  it('accepts a raw numeric seconds value', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(Number(createExpiry(60))).toBeCloseTo(now + 60, -1);
  });

  it('throws on malformed duration strings', () => {
    expect(() => createExpiry('1 hour')).toThrow(/Invalid duration/);
    expect(() => createExpiry('forever')).toThrow(/Invalid duration/);
    expect(() => createExpiry('1y')).toThrow(/Invalid duration/); // no year unit
  });
});

describe('tickToPercentage', () => {
  it('computes price * 100 correctly for standard tick', () => {
    expect(tickToPercentage(55, TICK_SIZE_STANDARD.toString())).toBe(55);
    expect(tickToPercentage('80', TICK_SIZE_STANDARD.toString())).toBe(80);
  });

  it('returns 0 when tick or tickSize is zero', () => {
    expect(tickToPercentage(0, TICK_SIZE_STANDARD.toString())).toBe(0);
    expect(tickToPercentage(50, 0)).toBe(0);
  });
});

describe('getOutcomePrice', () => {
  const tickSize = TICK_SIZE_STANDARD.toString();

  it('returns 100 for the winning outcome of a resolved market', () => {
    const market = {
      tickSize,
      status: 'Resolved',
      resolvedOutcome: 0,
      lastPriceTick_0: '0',
      lastPriceTick_1: '0',
    };
    expect(getOutcomePrice(market, 0)).toBe(100);
    expect(getOutcomePrice(market, 1)).toBe(0);
  });

  it('derives No price from Yes tick via complement', () => {
    const market = {
      tickSize,
      status: 'Active',
      resolvedOutcome: null,
      lastPriceTick_0: '60',
      lastPriceTick_1: null,
    };
    expect(getOutcomePrice(market, 0)).toBe(60);
    expect(getOutcomePrice(market, 1)).toBe(40);
  });

  it('derives Yes price from No tick via complement when only No traded', () => {
    const market = {
      tickSize,
      status: 'Active',
      resolvedOutcome: null,
      lastPriceTick_0: null,
      lastPriceTick_1: '30',
    };
    expect(getOutcomePrice(market, 1)).toBe(30);
    expect(getOutcomePrice(market, 0)).toBe(70);
  });
});

describe('calculateChancePercent waterfall', () => {
  const tickSize = TICK_SIZE_STANDARD.toString();

  it('returns 50 when tickSize is zero / missing', () => {
    expect(calculateChancePercent({ tickSize: '0' })).toBe(50);
  });

  it('returns 100/0 for a resolved market', () => {
    expect(
      calculateChancePercent({
        tickSize,
        status: 'Resolved',
        resolvedOutcome: 0,
      }),
    ).toBe(100);
    expect(
      calculateChancePercent({
        tickSize,
        status: 'Resolved',
        resolvedOutcome: 1,
      }),
    ).toBe(0);
  });

  it('uses implied midpoint when the book is tight (<= $0.10 spread)', () => {
    // Yes bid 60, Yes ask 62 — direct book, 2-cent spread. Midpoint = 61.
    const pct = calculateChancePercent({
      tickSize,
      topOfBook: [
        { outcome: '0', side: 'BUY', topTick: '60' },
        { outcome: '0', side: 'SELL', topTick: '62' },
      ],
    });
    expect(pct).toBe(61);
  });

  it('derives implied Yes bid from the No ask (merge path)', () => {
    // No ask at 40 → implied Yes bid = 100 - 40 = 60.
    // Yes ask at 63 → spread is 63-60 = 3 ticks = $0.03 (within threshold).
    // Midpoint = 61.5, rounds to 61.5.
    const pct = calculateChancePercent({
      tickSize,
      topOfBook: [
        { outcome: '0', side: 'SELL', topTick: '63' },
        { outcome: '1', side: 'SELL', topTick: '40' },
      ],
    });
    expect(pct).toBeCloseTo(61.5, 1);
  });

  it('falls back to last trade when spread is too wide', () => {
    // 20-tick spread ($0.20) → above $0.10 threshold → fall back to last trade.
    const pct = calculateChancePercent({
      tickSize,
      topOfBook: [
        { outcome: '0', side: 'BUY', topTick: '40' },
        { outcome: '0', side: 'SELL', topTick: '60' },
      ],
      lastPriceTick_0: '55',
    });
    expect(pct).toBe(55);
  });

  it('returns 50 when there is no book and no last-trade data', () => {
    expect(calculateChancePercent({ tickSize })).toBe(50);
    expect(calculateChancePercent({ tickSize, topOfBook: [] })).toBe(50);
  });

  it('derives last-trade price from the No side via complement', () => {
    const pct = calculateChancePercent({
      tickSize,
      lastPriceTick_0: null,
      lastPriceTick_1: '30',
    });
    expect(pct).toBe(70);
  });
});

describe('parseAncillaryData / formatAncillaryData round-trip', () => {
  it('formats with both title and description', () => {
    expect(
      formatAncillaryData({
        title: 'Will ETH hit $5k?',
        description: 'Resolves YES by Dec 31.',
      }),
    ).toBe('q:title:Will ETH hit $5k?,description:Resolves YES by Dec 31.');
  });

  it('round-trips a simple title+description through the contract format', () => {
    const q = {
      title: 'Will ETH hit $5k?',
      description: 'Market resolves YES if ETH >= $5000.',
    };
    const formatted = formatAncillaryData(q);
    const parsed = parseAncillaryData(formatted);
    expect(parsed.title).toBe(q.title);
    expect(parsed.description).toBe(q.description);
  });

  it('preserves commas inside the title and description', () => {
    const q = {
      title: 'A, B, or C?',
      description: 'Three-way, with commas, everywhere.',
    };
    const formatted = formatAncillaryData(q);
    const parsed = parseAncillaryData(formatted);
    expect(parsed.title).toBe(q.title);
    expect(parsed.description).toBe(q.description);
  });

  it('parses contract-appended ancillary with chain metadata correctly', () => {
    const raw =
      'q:title:Some title,description:Some description,market_id:7,venue_id:3,initializer:0x0000000000000000000000000000000000000001,chain_id:84532';
    const parsed = parseAncillaryData(raw);
    expect(parsed.title).toBe('Some title');
    expect(parsed.description).toBe('Some description');
  });

  it('handles title-only ancillary data', () => {
    const raw = 'q:title:Just a title';
    expect(parseAncillaryData(raw)).toEqual({
      title: 'Just a title',
      description: '',
    });
  });

  it('falls back to raw data when the format is unrecognizable', () => {
    const garbage = 'this is not ancillary data';
    expect(parseAncillaryData(garbage)).toEqual({
      title: garbage,
      description: '',
    });
  });
});
