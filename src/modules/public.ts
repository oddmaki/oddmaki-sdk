import { BaseModule } from './base';
import { calculateChancePercent } from '../utils/conversions';

/**
 * Market lifecycle statuses indexed by the subgraph. Mirrors the on-chain
 * market state machine.
 */
export type MarketStatus = 'Draft' | 'Active' | 'Resolved' | 'Invalid';

const ALL_MARKET_STATUSES: MarketStatus[] = ['Draft', 'Active', 'Resolved', 'Invalid'];
import {
  GET_VENUES,
  GET_MARKETS,
  GET_MARKETS_WITH_PRICING,
  GET_MARKET,
  GET_TRADES,
  GET_ORDERS,
  GET_USER,
  GET_TOP_OF_BOOK,
  GET_PROTOCOL_STATS,
  GET_MARKET_GROUPS,
  GET_MARKET_GROUP,
  GET_GROUP_MARKETS,
  GET_MARKET_GROUP_ITEM,
  GET_UNIFIED_MARKET_FEED,
  GET_UNIFIED_MARKET_FEED_BY_VOLUME,
  GET_ALL_MARKETS_FEED,
  GET_ALL_MARKETS_FEED_BY_VOLUME,
  GET_RECENT_TRADES,
  GET_RECENT_MARKETS,
  GET_CHART_TRADES,
  GET_CHART_TRADES_ALL,
  GET_TRADER_PROFILE,
  GET_TRADER_POSITIONS,
  GET_TRADER_CLOSED_POSITIONS,
  GET_TRADER_FILLS,
  GET_LEADERBOARD,
  GET_MARKET_TOP_HOLDERS,
} from '../subgraph/queries';

export class PublicModule extends BaseModule {
  /**
   * Get all venues
   */
  async getVenues(params?: {
    first?: number;
    skip?: number;
    orderBy?: string;
    orderDirection?: 'asc' | 'desc';
  }) {
    return this.subgraph.request(GET_VENUES, {
      first: params?.first || 100,
      skip: params?.skip || 0,
      orderBy: params?.orderBy || 'createdAt',
      orderDirection: params?.orderDirection || 'desc',
    });
  }

  /**
   * Get markets for a venue
   */
  async getMarkets(params: {
    venueId?: bigint;
    search?: string;
    statuses?: MarketStatus[];
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request(GET_MARKETS, {
      venueId: params.venueId?.toString(),
      search: params.search ?? '',
      statuses: params.statuses ?? ALL_MARKET_STATUSES,
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get markets with pricing data (last trade prices + statistics)
   *
   * @param params.search Optional case-insensitive substring match against the
   *   market `question` field. Empty string matches all markets.
   * @param params.statuses Optional list of market statuses to include. Omit
   *   to include all statuses (Draft, Active, Resolved, Invalid).
   */
  async getMarketsWithPricing(params: {
    venueId?: bigint;
    search?: string;
    statuses?: MarketStatus[];
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request(GET_MARKETS_WITH_PRICING, {
      venueId: params.venueId?.toString(),
      search: params.search ?? '',
      statuses: params.statuses ?? ALL_MARKET_STATUSES,
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get market by ID
   */
  async getMarket(marketId: bigint) {
    const response = await this.subgraph.request<any>(GET_MARKET, {
      marketId: marketId.toString(),
    });
    return response.markets[0] || null;
  }

  /**
   * Get trade history for a market
   */
  async getTradeHistory(params: {
    marketId: bigint;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_TRADES, {
      marketId: params.marketId.toString(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get trade data optimized for price charting.
   * Supports time-window filtering and higher limits.
   */
  async getChartTrades(params: {
    marketId: bigint;
    timestampGte?: bigint;
    first?: number;
    skip?: number;
  }) {
    const variables: Record<string, any> = {
      marketId: params.marketId.toString(),
      first: params.first || 1000,
      skip: params.skip || 0,
    };

    // Use a separate query without timestamp_gte filter for ALL timeframe
    // The subgraph treats timestamp_gte: null as a filter that matches nothing
    if (params.timestampGte !== undefined) {
      variables.timestampGte = params.timestampGte.toString();
      return this.subgraph.request<any>(GET_CHART_TRADES, variables);
    }

    return this.subgraph.request<any>(GET_CHART_TRADES_ALL, variables);
  }

  /**
   * Get orders for a market
   */
  async getOrders(params: { marketId: bigint; first?: number; skip?: number }) {
    return this.subgraph.request<any>(GET_ORDERS, {
      marketId: params.marketId.toString(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get user data by address
   */
  async getUser(address: string) {
    return this.subgraph.request<any>(GET_USER, {
      address: address.toLowerCase(),
    });
  }

  /**
   * Get top of book for a market
   */
  async getTopOfBook(marketId: bigint) {
    return this.subgraph.request<any>(GET_TOP_OF_BOOK, {
      marketId: marketId.toString(),
    });
  }

  /**
   * Get protocol-wide statistics
   */
  async getProtocolStats() {
    return this.subgraph.request<any>(GET_PROTOCOL_STATS);
  }

  // ============================================
  // Market Groups
  // ============================================

  /**
   * Get market groups for a venue
   */
  async getMarketGroups(params: {
    venueId?: bigint;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request(GET_MARKET_GROUPS, {
      venueId: params.venueId?.toString(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get market group by ID
   */
  async getMarketGroup(groupId: bigint) {
    const response = await this.subgraph.request<any>(GET_MARKET_GROUP, {
      groupId: groupId.toString(),
    });
    return response.marketGroups[0] || null;
  }

  /**
   * Get all markets in a group
   */
  async getGroupMarkets(params: {
    groupId: bigint;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_GROUP_MARKETS, {
      groupId: params.groupId.toString(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get market group item data (group-specific metadata)
   */
  async getMarketGroupItem(marketId: bigint) {
    const response = await this.subgraph.request<any>(GET_MARKET_GROUP_ITEM, {
      marketId: marketId.toString(),
    });
    return response.marketGroupItems[0] || null;
  }

  // ============================================
  // Unified Market Feed (Polymarket-style)
  // ============================================

  /**
   * Get unified feed of standalone markets + market groups
   * Returns both types in a single query, similar to Polymarket's homepage
   *
   * @param params.venueId - Optional venue filter
   * @param params.first - Number of items per type (default 50)
   * @param params.skip - Pagination offset
   * @param params.sortBy - Sort order: 'created' (newest first) or 'volume' (most popular)
   *
   * @returns Object with standaloneMarkets and marketGroups arrays
   */
  async getUnifiedMarketFeed(params?: {
    venueId?: bigint;
    first?: number;
    skip?: number;
    sortBy?: 'created' | 'volume';
  }) {
    const sortBy = params?.sortBy || 'created';

    if (sortBy === 'volume') {
      return this.subgraph.request<any>(GET_UNIFIED_MARKET_FEED_BY_VOLUME, {
        venueId: params?.venueId?.toString(),
        first: params?.first || 50,
        skip: params?.skip || 0,
      });
    }

    return this.subgraph.request<any>(GET_UNIFIED_MARKET_FEED, {
      venueId: params?.venueId?.toString(),
      first: params?.first || 50,
      skip: params?.skip || 0,
    });
  }

  /**
   * Merge and sort unified feed results
   * Combines standaloneMarkets and marketGroups into a single sorted array
   */
  mergeAndSortFeed(
    feedData: any,
    sortBy: 'created' | 'volume' = 'created',
    limit?: number,
  ): Array<any> {
    const standalone = (feedData.standaloneMarkets || []).map((m: any) => ({
      ...m,
      type: 'standalone' as const,
      sortValue:
        sortBy === 'volume'
          ? BigInt(m.totalVolume || '0')
          : BigInt(m.createdAt || '0'),
    }));

    const groups = (feedData.marketGroups || []).map((g: any) => {
      // Calculate total volume for group (sum of all child markets)
      const totalVolume =
        g.markets?.reduce(
          (sum: bigint, m: any) => sum + BigInt(m.totalVolume || '0'),
          0n,
        ) || 0n;

      return {
        ...g,
        type: 'group' as const,
        totalVolume: totalVolume.toString(),
        sortValue:
          sortBy === 'volume' ? totalVolume : BigInt(g.createdAt || '0'),
      };
    });

    // Merge and sort
    const merged = [...standalone, ...groups].sort((a, b) => {
      // Sort descending (highest/newest first)
      return a.sortValue > b.sortValue ? -1 : 1;
    });

    // Apply limit if specified
    return limit ? merged.slice(0, limit) : merged;
  }

  /**
   * Calculate probability for a market using mark price waterfall.
   * Returns probability as a decimal string (e.g., "0.65" for 65%)
   *
   * Uses Polymarket-style pricing: implied midpoint → last trade → default 50%.
   *
   * @param market - Market object from subgraph (with topOfBook and timestamp fields)
   * @returns Probability string or null if no data available
   */
  calculateMarketProbability(market: any): string | null {
    if (!market.tickSize) return null;

    const chance = calculateChancePercent(market);
    if (chance === 50 && !market.lastPriceTick_0 && !market.lastPriceTick_1) {
      return null; // Truly no data — keep null for "no probability" display
    }
    return (chance / 100).toFixed(2);
  }

  /**
   * Format market group for display (Polymarket-style)
   * Enriches child markets with calculated probabilities and formats
   */
  formatMarketGroupForDisplay(group: any) {
    const outcomes = (group.markets || [])
      .filter((m: any) => !m.marketGroupItem?.isPlaceholder)
      .map((m: any) => ({
        marketId: m.marketId,
        name: m.marketGroupItem?.marketName || 'Unknown',
        question: m.question,
        probability: this.calculateMarketProbability(m),
        status: m.status,
        totalVolume: m.totalVolume,
      }))
      .sort((a: any, b: any) => {
        // Sort by probability (highest first)
        const probA = parseFloat(a.probability || '0');
        const probB = parseFloat(b.probability || '0');
        return probB - probA;
      });

    return {
      type: 'group' as const,
      groupId: group.groupId,
      marketQuestion: group.marketQuestion,
      status: group.status,
      totalMarkets: group.totalMarkets,
      activeMarketCount: group.activeMarketCount,
      resolvedMarketId: group.resolvedMarketId,
      createdAt: group.createdAt,
      outcomes,
      venue: group.venue,
      creator: group.creator,
    };
  }

  // ============================================
  // Cross-Venue Queries (Protocol App)
  // ============================================

  /**
   * Get all markets across all venues (no venue filter)
   * Returns standaloneMarkets + marketGroups for global market explorer
   *
   * @param params.first - Number of items per type (default 50)
   * @param params.skip - Pagination offset
   * @param params.sortBy - 'created' (newest) or 'volume' (most popular)
   */
  async getAllMarketsFeed(params?: {
    first?: number;
    skip?: number;
    sortBy?: 'created' | 'volume';
  }) {
    const sortBy = params?.sortBy || 'created';
    const query =
      sortBy === 'volume'
        ? GET_ALL_MARKETS_FEED_BY_VOLUME
        : GET_ALL_MARKETS_FEED;

    return this.subgraph.request<any>(query, {
      first: params?.first || 50,
      skip: params?.skip || 0,
    });
  }

  /**
   * Get top venues by volume
   */
  async getTopVenues(first = 10) {
    return this.subgraph.request(GET_VENUES, {
      first,
      skip: 0,
      orderBy: 'totalVolume',
      orderDirection: 'desc',
    });
  }

  /**
   * Get recent trades across all venues (for activity feed / ticker)
   */
  async getRecentTrades(params?: { first?: number; skip?: number }) {
    return this.subgraph.request<any>(GET_RECENT_TRADES, {
      first: params?.first || 20,
      skip: params?.skip || 0,
    });
  }

  /**
   * Get recently created markets across all venues
   */
  async getRecentMarkets(params?: { first?: number; skip?: number }) {
    return this.subgraph.request<any>(GET_RECENT_MARKETS, {
      first: params?.first || 20,
      skip: params?.skip || 0,
    });
  }

  // ============================================
  // Trader Analytics
  // ============================================

  /**
   * Get trader profile with aggregate stats
   */
  async getTraderProfile(address: string) {
    return this.subgraph.request<any>(GET_TRADER_PROFILE, {
      address: address.toLowerCase(),
    });
  }

  /**
   * Get trader's open positions (quantity > 0) with P&L data
   */
  async getTraderPositions(params: {
    trader: string;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_TRADER_POSITIONS, {
      trader: params.trader.toLowerCase(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get trader's closed positions (quantity = 0) with realized P&L
   */
  async getTraderClosedPositions(params: {
    trader: string;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_TRADER_CLOSED_POSITIONS, {
      trader: params.trader.toLowerCase(),
      first: params.first || 100,
      skip: params.skip || 0,
    });
  }

  /**
   * Get trader's fill history (activity feed)
   */
  async getTraderTrades(params: {
    trader: string;
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_TRADER_FILLS, {
      trader: params.trader.toLowerCase(),
      first: params.first || 50,
      skip: params.skip || 0,
    });
  }

  /**
   * Get leaderboard (top traders sorted by volume or P&L)
   */
  async getLeaderboard(params?: {
    orderBy?: 'totalVolume' | 'totalRealizedPnL' | 'totalTradeCount';
    orderDirection?: 'asc' | 'desc';
    first?: number;
    skip?: number;
  }) {
    return this.subgraph.request<any>(GET_LEADERBOARD, {
      orderBy: params?.orderBy || 'totalVolume',
      orderDirection: params?.orderDirection || 'desc',
      first: params?.first || 50,
      skip: params?.skip || 0,
    });
  }

  /**
   * Get top holders for a market (by position size)
   */
  async getMarketTopHolders(params: {
    marketId: string;
    first?: number;
  }) {
    return this.subgraph.request<any>(GET_MARKET_TOP_HOLDERS, {
      marketId: params.marketId,
      first: params.first || 20,
    });
  }
}
