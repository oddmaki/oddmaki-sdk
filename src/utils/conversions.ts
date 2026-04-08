import { parseEther, formatEther } from 'viem';

/**
 * Utility functions for common conversions in OddMaki Protocol
 * These helpers make it easier for frontends to work with the protocol
 * without needing to understand ticks, BigInts, and wei conversions
 */

/** Standard tick size: 1% price increment, 100 price levels (Polymarket/Kalshi standard) */
export const TICK_SIZE_STANDARD = 10000000000000000n; // 1e16

/** Fine tick size: 0.1% price increment, 1000 price levels (institutional-grade) */
export const TICK_SIZE_FINE = 1000000000000000n; // 1e15

/** All protocol-approved tick sizes */
export const VALID_TICK_SIZES = [TICK_SIZE_STANDARD, TICK_SIZE_FINE] as const;

/**
 * Check whether a tick size is in the protocol-approved whitelist.
 * @param tickSize - Tick size in wei (1e15 or 1e16)
 * @returns true if the tick size is valid
 */
export function isValidTickSize(tickSize: bigint): boolean {
  return tickSize === TICK_SIZE_STANDARD || tickSize === TICK_SIZE_FINE;
}

/**
 * Convert a tick value to a human-readable price
 * @param tick - Tick value (e.g., 80 for 0.80)
 * @param tickSize - Optional tick size in 1e18 (defaults to 0.01e18)
 * @returns Price as decimal string (e.g., "0.80")
 */
export function tickToPrice(tick: bigint, tickSize: bigint = 10000000000000000n): string {
  const price = tick * tickSize;
  return (Number(price) / 1e18).toFixed(2);
}

/**
 * Convert a human-readable price to a tick value
 * @param price - Price as decimal (e.g., 0.80 or "0.80")
 * @returns Tick value as bigint (e.g., 80n)
 */
export function priceToTick(price: number | string): bigint {
  const priceNum = typeof price === 'string' ? parseFloat(price) : price;
  return BigInt(Math.round(priceNum * 100));
}

/**
 * Convert a decimal amount string to the smallest unit based on decimals
 * @param amount - Amount as decimal string (e.g., "10.5")
 * @param decimals - Token decimals (default: 18 for ETH-like tokens, use 6 for USDC)
 * @returns BigInt in smallest unit
 *
 * @example
 * parseAmount("10.5") // 10500000000000000000n (18 decimals)
 * parseAmount("10.5", 6) // 10500000n (6 decimals for USDC)
 */
export function parseAmount(amount: string, decimals: number = 18): bigint {
  if (decimals === 18) {
    return parseEther(amount);
  }

  // Parse amount with custom decimals
  const parts = amount.split('.');
  const wholePart = parts[0] || '0';
  const decimalPart = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);

  return BigInt(wholePart + decimalPart);
}

/**
 * Convert smallest unit amount to decimal string based on decimals
 * @param amount - Amount in smallest unit (bigint)
 * @param decimals - Token decimals (default: 18 for ETH-like tokens, use 6 for USDC)
 * @returns Decimal string (e.g., "10.5")
 *
 * @example
 * formatAmount(10500000000000000000n) // "10.5" (18 decimals)
 * formatAmount(10500000n, 6) // "10.5" (6 decimals for USDC)
 */
export function formatAmount(amount: bigint, decimals: number = 18): string {
  if (decimals === 18) {
    return formatEther(amount);
  }

  // Format amount with custom decimals
  const amountStr = amount.toString().padStart(decimals + 1, '0');
  const wholePart = amountStr.slice(0, -decimals) || '0';
  const decimalPart = amountStr.slice(-decimals);

  // Remove trailing zeros from decimal part
  const trimmedDecimal = decimalPart.replace(/0+$/, '');

  return trimmedDecimal ? `${wholePart}.${trimmedDecimal}` : wholePart;
}

/**
 * Create an expiry timestamp from duration
 * @param duration - Duration string like "1h", "24h", "7d" or number of seconds
 * @returns Unix timestamp as bigint
 */
export function createExpiry(duration: string | number): bigint {
  let seconds: number;

  if (typeof duration === 'number') {
    seconds = duration;
  } else {
    // Parse duration strings like "1h", "24h", "7d"
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid duration format. Use formats like "1h", "24h", "7d"');
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };

    seconds = value * multipliers[unit];
  }

  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

/**
 * Format a timestamp for display
 * @param timestamp - Unix timestamp (bigint or number)
 * @returns Human-readable date string
 */
export function formatTimestamp(timestamp: bigint | number): string {
  const ts = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
  return new Date(ts * 1000).toLocaleString();
}

/**
 * Market question structure
 */
export interface MarketQuestion {
  title: string;
  description: string;
}

/**
 * Parse UMA ancillary data into structured question format
 * @param ancillaryData - Raw ancillary data string from contract/subgraph
 * @returns Parsed question with title and description
 *
 * @example
 * ```typescript
 * const question = parseAncillaryData("q:title:Will ETH hit $5k?,description:Market resolves YES if...");
 * console.log(question.title); // "Will ETH hit $5k?"
 * console.log(question.description); // "Market resolves YES if..."
 * ```
 */
export function parseAncillaryData(ancillaryData: string): MarketQuestion {
  try {
    // Format: "q:title:TITLE,description:DESC,market_id:N,venue_id:N,initializer:0x...,res_data:...,ooRequester:0x...,chain_id:N"
    // Title and description can contain commas, so we can't split on all commas.
    // Instead, use the known contract-appended keys as boundaries.
    const CONTRACT_KEY_RE = /,(?:market_id|venue_id|initializer|res_data|ooRequester|chain_id):/;

    let title = '';
    let description = '';

    // Find where title starts (supports both "q:title:" and "title:" prefixes)
    const titlePrefix = ancillaryData.match(/^(?:q:)?title:/);
    if (titlePrefix) {
      const afterTitle = ancillaryData.slice(titlePrefix[0].length);

      // Title ends at ",description:" or first contract-appended key
      const descIdx = afterTitle.indexOf(',description:');

      if (descIdx >= 0) {
        title = afterTitle.slice(0, descIdx).trim();
        const descRest = afterTitle.slice(descIdx + ',description:'.length);
        const keyMatch = descRest.match(CONTRACT_KEY_RE);
        description = keyMatch
          ? descRest.slice(0, keyMatch.index).trim()
          : descRest.trim();
      } else {
        const keyMatch = afterTitle.match(CONTRACT_KEY_RE);
        title = keyMatch
          ? afterTitle.slice(0, keyMatch.index).trim()
          : afterTitle.trim();
      }
    }

    return {
      title: title || ancillaryData, // Fallback to raw data if parsing fails
      description: description || '',
    };
  } catch (e) {
    // If parsing fails, return the raw data as title
    return { title: ancillaryData, description: '' };
  }
}

/**
 * Format a market question into UMA ancillary data string
 * @param question - Question with title and description
 * @returns Formatted ancillary data string (without market/venue metadata)
 *
 * @example
 * ```typescript
 * const ancillaryData = formatAncillaryData({
 *   title: "Will ETH hit $5k?",
 *   description: "Market resolves YES if ETH/USD >= $5000 on Coinbase Pro by Dec 31, 2025."
 * });
 * // Returns: "q:title:Will ETH hit $5k?,description:Market resolves YES if..."
 * ```
 *
 * @note The Controller/UmaAdapter will append additional fields (market_id, venue_id, etc.)
 */
export function formatAncillaryData(question: MarketQuestion): string {
  let data = `q:title:${question.title}`;
  if (question.description) {
    data += `,description:${question.description}`;
  }
  return data;
}

/**
 * Convert a tick value and tick size to a percentage (0-100).
 * Accepts string or number inputs for convenience with subgraph data.
 *
 * @param tick - Tick value (e.g., 55 or "55")
 * @param tickSize - Tick size in wei (e.g., 1e16 or "10000000000000000")
 * @returns Price as percentage (e.g., 55 for 55%)
 */
export function tickToPercentage(tick: string | number, tickSize: string | number): number {
  const tickNum = typeof tick === 'string' ? parseFloat(tick) : tick;
  const tickSizeNum = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  if (tickNum === 0 || tickSizeNum === 0) return 0;
  const price = (tickNum * tickSizeNum) / 1e18;
  return parseFloat((price * 100).toFixed(2));
}

/**
 * Subgraph Market entity shape expected by getOutcomePrice.
 */
export interface SubgraphMarketPriceData {
  tickSize: string;
  status: string;
  resolvedOutcome?: number | string | null;
  lastPriceTick_0?: string | null;
  lastPriceTick_1?: string | null;
}

/**
 * Get the current price percentage (0-100) for an outcome in a binary market.
 *
 * Handles three cases:
 * 1. Resolved markets → winning outcome = 100, losing = 0
 * 2. Active markets with YES price → NO = 100 - YES (complement)
 * 3. Active markets with only NO price → YES = 100 - NO
 *
 * @param market - Subgraph Market entity with price/status fields
 * @param outcomeIndex - 0 for YES, 1 for NO
 * @returns Price as percentage (0-100)
 */
export function getOutcomePrice(market: SubgraphMarketPriceData, outcomeIndex: number): number {
  const tickSize = market.tickSize || '0';

  // Resolved: winning = 100, losing = 0
  if (market.status === 'Resolved' && market.resolvedOutcome != null) {
    return parseInt(String(market.resolvedOutcome)) === outcomeIndex ? 100 : 0;
  }

  // Use YES price as canonical, derive NO via complement
  const yesTick = market.lastPriceTick_0;
  if (!yesTick) {
    const noTick = market.lastPriceTick_1;
    if (!noTick) return 0;
    const noPercent = tickToPercentage(noTick, tickSize);
    return outcomeIndex === 1 ? noPercent : (100 - noPercent);
  }

  const yesPercent = tickToPercentage(yesTick, tickSize);
  return outcomeIndex === 0 ? yesPercent : (100 - yesPercent);
}

// ============================================
// Mark Price Calculation (Polymarket-style)
// ============================================

/**
 * Top-of-book entry from subgraph TopOfBook entity.
 */
export interface TopOfBookEntry {
  outcome: string; // "0" or "1"
  side: string; // "BUY" or "SELL"
  topTick: string; // tick value, "0" if empty
}

/**
 * Input for calculateChancePercent — accepts subgraph market data.
 */
export interface ChancePercentInput {
  tickSize: string;
  status?: string;
  resolvedOutcome?: number | string | null;
  lastPriceTick_0?: string | null;
  lastPriceTick_1?: string | null;
  lastTradeTimestamp_0?: string | null;
  lastTradeTimestamp_1?: string | null;
  topOfBook?: TopOfBookEntry[];
}

/** Spread threshold in dollars — matches Polymarket's $0.10 threshold. */
const MARK_PRICE_SPREAD_THRESHOLD = 0.10;

/**
 * Calculate the "chance %" for a binary market using a Polymarket-style waterfall:
 *
 * 1. **Implied mark price** (midpoint of implied Yes bid/ask) — if spread ≤ $0.10
 * 2. **Last trade** (most recent trade from either side) — if book empty or spread > $0.10
 * 3. **50%** — no data
 *
 * Implied prices account for cross-outcome liquidity via mint/merge paths:
 * - No BUY at tick N → implied Yes ASK at (maxTicks - N) via Mint path
 * - No SELL at tick N → implied Yes BID at (maxTicks - N) via Merge path
 *
 * @param market - Subgraph market data with top-of-book and last trade info
 * @returns Chance percentage (0-100)
 */
export function calculateChancePercent(market: ChancePercentInput): number {
  const tickSizeNum = parseFloat(market.tickSize || '0');
  if (tickSizeNum === 0) return 50;

  // Resolved markets: winning = 100%, losing = 0%
  if (market.status === 'Resolved' && market.resolvedOutcome != null) {
    return parseInt(String(market.resolvedOutcome)) === 0 ? 100 : 0;
  }

  const maxTicks = 1e18 / tickSizeNum;

  // Step 1: Try mark price from top-of-book (implied midpoint)
  if (market.topOfBook && market.topOfBook.length > 0) {
    const tob = parseTopOfBook(market.topOfBook);
    const result = computeImpliedMidpoint(tob, maxTicks, tickSizeNum);
    if (result !== null) return result;
  }

  // Step 2: Fall back to most recent trade (either side)
  return lastTradeFallback(market, tickSizeNum);
}

/**
 * Parsed top-of-book values (all in raw tick units).
 */
interface ParsedTopOfBook {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

/**
 * Parse the TopOfBook array into the 4 values we need.
 */
function parseTopOfBook(entries: TopOfBookEntry[]): ParsedTopOfBook {
  const result: ParsedTopOfBook = { yesBid: 0, yesAsk: 0, noBid: 0, noAsk: 0 };

  for (const entry of entries) {
    const tick = parseFloat(entry.topTick || '0');
    const outcome = entry.outcome?.toString();
    const side = entry.side;

    if (outcome === '0' && side === 'BUY') result.yesBid = tick;
    else if (outcome === '0' && side === 'SELL') result.yesAsk = tick;
    else if (outcome === '1' && side === 'BUY') result.noBid = tick;
    else if (outcome === '1' && side === 'SELL') result.noAsk = tick;
  }

  return result;
}

/**
 * Compute the implied Yes midpoint from top-of-book data.
 * Returns the chance percentage, or null if we can't compute a valid midpoint.
 */
function computeImpliedMidpoint(
  tob: ParsedTopOfBook,
  maxTicks: number,
  tickSize: number,
): number | null {
  // Compute implied Yes bid: max(direct Yes bid, complement of No ask via merge)
  const bidCandidates: number[] = [];
  if (tob.yesBid > 0) bidCandidates.push(tob.yesBid);
  if (tob.noAsk > 0) bidCandidates.push(maxTicks - tob.noAsk);

  // Compute implied Yes ask: min(direct Yes ask, complement of No bid via mint)
  const askCandidates: number[] = [];
  if (tob.yesAsk > 0) askCandidates.push(tob.yesAsk);
  if (tob.noBid > 0) askCandidates.push(maxTicks - tob.noBid);

  // Need both a bid and an ask to compute midpoint
  if (bidCandidates.length === 0 || askCandidates.length === 0) return null;

  const impliedBid = Math.max(...bidCandidates);
  const impliedAsk = Math.min(...askCandidates);

  // Check spread threshold (in dollar terms)
  const spreadDollars = ((impliedAsk - impliedBid) * tickSize) / 1e18;
  if (spreadDollars > MARK_PRICE_SPREAD_THRESHOLD) return null;

  // Midpoint → percentage
  const midTick = (impliedBid + impliedAsk) / 2;
  const percent = (midTick * tickSize / 1e18) * 100;
  return parseFloat(Math.max(0, Math.min(100, percent)).toFixed(2));
}

/**
 * Fall back to the most recent trade from either side.
 * If per-outcome timestamps are available, use the more recent one.
 * Otherwise, use whichever lastPriceTick is available (with complement derivation for No).
 */
function lastTradeFallback(market: ChancePercentInput, tickSize: number): number {
  const tick0 = parseFloat(market.lastPriceTick_0 || '0');
  const tick1 = parseFloat(market.lastPriceTick_1 || '0');
  const ts0 = parseFloat(market.lastTradeTimestamp_0 || '0');
  const ts1 = parseFloat(market.lastTradeTimestamp_1 || '0');

  // Both outcomes have trades: use the more recent one
  if (tick0 > 0 && tick1 > 0) {
    if (ts0 > 0 || ts1 > 0) {
      // Per-outcome timestamps available — use most recent
      if (ts0 >= ts1) {
        return parseFloat(((tick0 * tickSize / 1e18) * 100).toFixed(2));
      }
      // No side is more recent — derive Yes via complement
      return parseFloat(((1 - (tick1 * tickSize / 1e18)) * 100).toFixed(2));
    }
    // No per-outcome timestamps (pre-migration data) — prefer Yes price
    return parseFloat(((tick0 * tickSize / 1e18) * 100).toFixed(2));
  }

  // Only Yes traded
  if (tick0 > 0) {
    return parseFloat(((tick0 * tickSize / 1e18) * 100).toFixed(2));
  }

  // Only No traded — derive Yes via complement
  if (tick1 > 0) {
    return parseFloat(((1 - (tick1 * tickSize / 1e18)) * 100).toFixed(2));
  }

  // No data at all
  return 50;
}
