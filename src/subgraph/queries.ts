import { gql } from 'graphql-request';

export const GET_VENUES = gql`
  query GetVenues(
    $first: Int = 100
    $skip: Int = 0
    $orderBy: Venue_orderBy = createdAt
    $orderDirection: OrderDirection = desc
  ) {
    venues(
      first: $first
      skip: $skip
      orderBy: $orderBy
      orderDirection: $orderDirection
    ) {
      id
      venueId
      name
      operator
      metadata
      # Fee configuration
      venueFeeBps
      creatorFeeBps
      # Oracle configuration
      umaRewardAmount
      umaMinBond
      # Access control
      tradingAccessControl
      creationAccessControl
      # State
      paused
      # Statistics
      totalMarkets
      totalMarketGroups
      activeMarkets
      totalVolume
      totalFees
      # Timestamps
      createdAt
    }
  }
`;

export const GET_MARKETS = gql`
  query GetMarkets(
    $venueId: BigInt
    $search: String = ""
    $statuses: [MarketStatus!] = [Draft, Active, Resolved, Invalid]
    $first: Int = 100
    $skip: Int = 0
  ) {
    markets(
      where: {
        venue_: { venueId: $venueId }
        question_contains_nocase: $search
        status_in: $statuses
      }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      conditionId
      tickSize
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      tags
      metadataURI
    }
  }
`;

export const GET_MARKETS_WITH_PRICING = gql`
  query GetMarketsWithPricing(
    $venueId: BigInt
    $search: String = ""
    $statuses: [MarketStatus!] = [Draft, Active, Resolved, Invalid]
    $first: Int = 100
    $skip: Int = 0
  ) {
    markets(
      where: {
        venue_: { venueId: $venueId }
        question_contains_nocase: $search
        status_in: $statuses
      }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      conditionId
      tickSize
      # Last trade prices
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      # Top of book for mark price calculation
      topOfBook {
        outcome
        side
        topTick
      }
      # Statistics
      totalVolume
      totalOrders
      uniqueTraders
      tags
      metadataURI
    }
  }
`;

export const GET_MARKET = gql`
  query GetMarket($marketId: BigInt!) {
    markets(where: { marketId: $marketId }) {
      id
      marketId
      question
      outcomes
      status
      resolvedOutcome
      collateralToken
      conditionId
      tickSize
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      totalVolume
      totalOrders
      totalFees
      uniqueTraders
      tags
      metadataURI
      createdAt
      creator {
        id
        address
      }
    }
  }
`;

export const GET_TRADES = gql`
  query GetTrades($marketId: BigInt, $first: Int = 100, $skip: Int = 0) {
    trades(
      where: { market_: { marketId: $marketId } }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      market {
        marketId
      }
      outcome
      tick
      amount
      cost
      tradeType
      buyTrader {
        id
      }
      sellTrader {
        id
      }
      avgPrice
      timestamp
      blockNumber
      transactionHash
    }
  }
`;

/**
 * Unified market activity feed: Trade entities (all kinds) UNION MergeFill
 * Fill entities, dual-cursor paginated by timestamp.
 *
 * Why two cursors: merges are a separate stream with very different density
 * than trades. A single shared cursor would over-skip the sparser stream and
 * miss merges. Each stream advances independently — clients pass back the
 * timestamp of the last item received from each stream as the next cursor.
 *
 * Uses `timestamp_lte` (not `_lt`) so boundary items at the exact cursor
 * timestamp aren't skipped — clients should dedupe by entity id, which
 * costs at most one duplicated row per page (the cursor item itself).
 *
 * Pass `9999999999` (year 2286) as sentinel for the first page to avoid
 * The Graph's "_lte: null matches nothing" behavior.
 */
export const GET_MARKET_ACTIVITY = gql`
  query GetMarketActivity(
    $marketId: BigInt!
    $first: Int!
    $tradeBefore: BigInt!
    $fillBefore: BigInt!
  ) {
    trades(
      where: {
        market_: { marketId: $marketId }
        timestamp_lte: $tradeBefore
      }
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      outcome
      tick
      amount
      cost
      tradeType
      buyTrader {
        id
      }
      sellTrader {
        id
      }
      avgPrice
      timestamp
      blockNumber
      transactionHash
    }
    mergeFills: fills(
      where: {
        market_: { marketId: $marketId }
        tradeType: MergeFill
        timestamp_lte: $fillBefore
      }
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      outcome
      tick
      amount
      cost
      trader {
        id
      }
      timestamp
      blockNumber
      transactionHash
    }
  }
`;

export const GET_CHART_TRADES = gql`
  query GetChartTrades(
    $marketId: BigInt!
    $timestampGte: BigInt
    $first: Int = 1000
    $skip: Int = 0
  ) {
    trades(
      where: { market_: { marketId: $marketId }, timestamp_gte: $timestampGte }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: asc
    ) {
      tick
      timestamp
      outcome
    }
  }
`;

export const GET_CHART_TRADES_ALL = gql`
  query GetChartTradesAll(
    $marketId: BigInt!
    $first: Int = 1000
    $skip: Int = 0
  ) {
    trades(
      where: { market_: { marketId: $marketId } }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: asc
    ) {
      tick
      timestamp
      outcome
    }
  }
`;

export const GET_ORDERS = gql`
  query GetOrders($marketId: BigInt, $first: Int = 100, $skip: Int = 0) {
    orders(
      where: { market_: { marketId: $marketId }, deleted: false }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      orderId
      market {
        marketId
      }
      trader {
        address
      }
      outcome
      side
      tick
      amount
      filled
      status
      createdAt
      createdAtBlock
      cancelledAt
      expiredAt
    }
  }
`;

export const GET_USER = gql`
  query GetUser($address: Bytes!) {
    user(id: $address) {
      id
      address
      totalOrdersPlaced
      totalVolume
      totalMarkets
      totalTradeCount
      totalMarketsTraded
      totalRealizedPnL
      firstSeenAt
      lastSeenAt
    }
  }
`;

export const GET_TOP_OF_BOOK = gql`
  query GetTopOfBook($marketId: BigInt!) {
    topOfBooks(where: { market_: { marketId: $marketId } }) {
      id
      market {
        marketId
      }
      outcome
      side
      topTick
      updatedAt
      updatedAtBlock
    }
  }
`;

export const GET_PROTOCOL_STATS = gql`
  query GetProtocolStats {
    protocol(id: "1") {
      id
      totalVenues
      totalMarkets
      totalMarketGroups
      totalVolume
      totalFees
      totalUsers
      updatedAt
    }
  }
`;

export const GET_QUESTION = gql`
  query GetQuestion($questionId: ID!) {
    question(id: $questionId) {
      id
      questionId
      conditionId
      ancillaryData
      liveness
      requiredBond
      currency
      reward
      resolved
      outcome
      activeAssertion {
        assertionId
        proposedOutcome
        settled
        result
        createdAt
      }
      assertions {
        assertionId
        proposedOutcome
        settled
        result
        createdAt
        settledAt
      }
      createdAt
      resolvedAt
    }
  }
`;

export const GET_QUESTIONS = gql`
  query GetQuestions($first: Int = 100, $skip: Int = 0) {
    questions(
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      questionId
      conditionId
      liveness
      requiredBond
      currency
      reward
      resolved
      outcome
      market {
        marketId
        question
        status
      }
      activeAssertion {
        assertionId
        proposedOutcome
      }
      createdAt
      resolvedAt
    }
  }
`;

// ============================================
// Market Groups
// ============================================

export const GET_MARKET_GROUPS = gql`
  query GetMarketGroups($venueId: BigInt, $first: Int = 100, $skip: Int = 0) {
    marketGroups(
      where: { venue_: { venueId: $venueId } }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      reward
      tags
      metadataURI
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      createdAt
      activatedAt
      resolvedAt
    }
  }
`;

export const GET_MARKET_GROUP = gql`
  query GetMarketGroup($groupId: BigInt!) {
    marketGroups(where: { groupId: $groupId }) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      tags
      metadataURI
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      createdAt
      createdAtBlock
      activatedAt
      resolvedAt
    }
  }
`;

export const GET_GROUP_MARKETS = gql`
  query GetGroupMarkets($groupId: BigInt!, $first: Int = 100, $skip: Int = 0) {
    markets(
      where: { groupId: $groupId }
      first: $first
      skip: $skip
      orderBy: marketId
      orderDirection: asc
    ) {
      id
      marketId
      question
      outcomes
      status
      resolvedOutcome
      collateralToken
      conditionId
      tickSize
      groupId
      marketGroupItem {
        marketName
        isPlaceholder
        createdAt
        activatedAt
      }
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      totalVolume
      totalOrders
      createdAt
    }
  }
`;

export const GET_MARKET_GROUP_ITEM = gql`
  query GetMarketGroupItem($marketId: BigInt!) {
    marketGroupItems(where: { market_: { marketId: $marketId } }) {
      id
      marketName
      isPlaceholder
      market {
        id
        marketId
        question
        status
      }
      marketGroup {
        id
        groupId
        marketQuestion
      }
      createdAt
      activatedAt
    }
  }
`;

// ============================================
// Unified Market Feed (Polymarket-style)
// ============================================

/**
 * Get unified feed of standalone markets + market groups
 * This query fetches both types in a single request for efficient homepage display
 * Frontend should merge and sort the results
 */
export const GET_UNIFIED_MARKET_FEED = gql`
  query GetUnifiedMarketFeed(
    $venueId: BigInt
    $first: Int = 50
    $skip: Int = 0
  ) {
    # Standalone binary markets (not in groups, not part of a price series)
    standaloneMarkets: markets(
      where: {
        groupId: "0"
        venue_: { venueId: $venueId }
        status_not: "Draft"
        priceSeries: null
      }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      conditionId
      tickSize
      groupId
      # Pricing data
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      # Statistics
      totalVolume
      totalOrders
      uniqueTraders
      tags
      metadataURI
      createdAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
    }

    # Market groups with their child markets
    marketGroups(
      where: { venue_: { venueId: $venueId }, status_not: "Draft" }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      tags
      metadataURI
      createdAt
      activatedAt
      resolvedAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      # Include child markets with their prices (no status filter — use isPlaceholder to filter)
      markets(
        orderBy: marketId
        orderDirection: asc
      ) {
        id
        marketId
        question
        status
        groupId
        tickSize
        # Pricing data for probability calculation
        lastPriceTick_0
        lastPriceTick_1
        totalVolume
        # Market group item metadata
        marketGroupItem {
          marketName
          isPlaceholder
        }
      }
    }

    # Price market series — one row per (venue, seriesKey)
    priceMarketSeries(
      where: { venue_: { venueId: $venueId }, status_not: "Resolved" }
      first: $first
      skip: $skip
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      seriesKey
      asset
      kind
      interval
      intervalSeconds
      status
      tags
      createdAt
      updatedAt
      currentMarket {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        conditionId
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        lastTradeTimestamp
        lastTradeTimestamp_0
        lastTradeTimestamp_1
        topOfBook {
          outcome
          side
          topTick
        }
        totalVolume
        metadataURI
        createdAt
        priceMarket {
          provider
          feedId
          strikePrice
          priceExpo
          openTime
          closeTime
        }
      }
      venue {
        id
        venueId
        name
      }
    }
  }
`;

/**
 * Get unified feed sorted by volume (most popular)
 */
export const GET_UNIFIED_MARKET_FEED_BY_VOLUME = gql`
  query GetUnifiedMarketFeedByVolume(
    $venueId: BigInt
    $first: Int = 50
    $skip: Int = 0
  ) {
    # Standalone binary markets sorted by volume (excluding price series members)
    standaloneMarkets: markets(
      where: {
        groupId: "0"
        venue_: { venueId: $venueId }
        status_not: "Draft"
        priceSeries: null
      }
      first: $first
      skip: $skip
      orderBy: totalVolume
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      groupId
      tickSize
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      totalVolume
      totalOrders
      uniqueTraders
      tags
      metadataURI
      createdAt
      venue {
        id
        venueId
        name
      }
    }

    # Market groups
    marketGroups(
      where: { venue_: { venueId: $venueId }, status_not: "Draft" }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      tags
      metadataURI
      createdAt
      activatedAt
      resolvedAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      markets {
        id
        marketId
        question
        status
        groupId
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        totalVolume
        marketGroupItem {
          marketName
          isPlaceholder
        }
      }
    }

    # Price market series — venue-scoped, only those with an active current market
    priceMarketSeries(
      where: { venue_: { venueId: $venueId }, status_not: "Resolved" }
      first: $first
      skip: $skip
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      seriesKey
      asset
      kind
      interval
      intervalSeconds
      status
      tags
      createdAt
      updatedAt
      currentMarket {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        lastTradeTimestamp
        lastTradeTimestamp_0
        lastTradeTimestamp_1
        topOfBook {
          outcome
          side
          topTick
        }
        totalVolume
        metadataURI
        createdAt
        priceMarket {
          provider
          feedId
          strikePrice
          priceExpo
          openTime
          closeTime
        }
      }
      venue {
        id
        venueId
        name
      }
    }
  }
`;

// ============================================
// Cross-Venue Queries (Protocol App)
// ============================================

/**
 * Get all markets across all venues (no venue filter)
 * Used by the protocol app's global market explorer
 */
export const GET_ALL_MARKETS_FEED = gql`
  query GetAllMarketsFeed($first: Int = 50, $skip: Int = 0) {
    # Standalone binary markets (not in groups, not part of a price series)
    standaloneMarkets: markets(
      where: { groupId: "0", status_not: "Draft", priceSeries: null }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      conditionId
      tickSize
      groupId
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      totalVolume
      totalOrders
      uniqueTraders
      metadataURI
      createdAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
    }

    # Market groups with their child markets
    marketGroups(
      where: { status_not: "Draft" }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      metadataURI
      createdAt
      activatedAt
      resolvedAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      markets(
        where: { status_not: "Draft" }
        orderBy: marketId
        orderDirection: asc
      ) {
        id
        marketId
        question
        status
        groupId
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        totalVolume
        marketGroupItem {
          marketName
          isPlaceholder
        }
      }
    }

    # Price market series across all venues
    priceMarketSeries(
      where: { status_not: "Resolved" }
      first: $first
      skip: $skip
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      seriesKey
      asset
      kind
      interval
      intervalSeconds
      status
      tags
      createdAt
      updatedAt
      currentMarket {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        lastTradeTimestamp
        topOfBook {
          outcome
          side
          topTick
        }
        totalVolume
        createdAt
        priceMarket {
          provider
          feedId
          strikePrice
          priceExpo
          openTime
          closeTime
        }
      }
      venue {
        id
        venueId
        name
      }
    }
  }
`;

/**
 * Get all markets across all venues sorted by volume
 */
export const GET_ALL_MARKETS_FEED_BY_VOLUME = gql`
  query GetAllMarketsFeedByVolume($first: Int = 50, $skip: Int = 0) {
    standaloneMarkets: markets(
      where: { groupId: "0", status_not: "Draft", priceSeries: null }
      first: $first
      skip: $skip
      orderBy: totalVolume
      orderDirection: desc
    ) {
      id
      marketId
      question
      outcomes
      status
      collateralToken
      conditionId
      tickSize
      groupId
      lastPriceTick_0
      lastPriceTick_1
      lastTradeTimestamp
      lastTradeTimestamp_0
      lastTradeTimestamp_1
      topOfBook {
        outcome
        side
        topTick
      }
      totalVolume
      totalOrders
      uniqueTraders
      metadataURI
      createdAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
    }

    marketGroups(
      where: { status_not: "Draft" }
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      groupId
      marketQuestion
      status
      totalMarkets
      activeMarketCount
      resolvedMarketId
      metadataURI
      createdAt
      activatedAt
      resolvedAt
      venue {
        id
        venueId
        name
      }
      creator {
        id
        address
      }
      markets {
        id
        marketId
        question
        status
        groupId
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        totalVolume
        marketGroupItem {
          marketName
          isPlaceholder
        }
      }
    }

    # Price market series across all venues, sorted by volume of current market
    priceMarketSeries(
      where: { status_not: "Resolved" }
      first: $first
      skip: $skip
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      seriesKey
      asset
      kind
      interval
      intervalSeconds
      status
      tags
      createdAt
      updatedAt
      currentMarket {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        lastTradeTimestamp
        topOfBook {
          outcome
          side
          topTick
        }
        totalVolume
        createdAt
        priceMarket {
          provider
          feedId
          strikePrice
          priceExpo
          openTime
          closeTime
        }
      }
      venue {
        id
        venueId
        name
      }
    }
  }
`;

/**
 * Get a single PriceMarketSeries with all its member markets, ordered by closeTime.
 * Used by the market detail page to render the time-button navigation strip.
 */
export const GET_PRICE_MARKET_SERIES = gql`
  query GetPriceMarketSeries($venueId: BigInt!, $seriesKey: String!) {
    priceMarketSeries(
      where: { venue_: { venueId: $venueId }, seriesKey: $seriesKey }
      first: 1
    ) {
      id
      seriesKey
      asset
      kind
      interval
      intervalSeconds
      status
      tags
      createdAt
      updatedAt
      currentMarket {
        id
        marketId
      }
      venue {
        id
        venueId
        name
      }
      markets(first: 1000, orderBy: marketId, orderDirection: asc) {
        id
        marketId
        question
        status
        resolvedOutcome
        outcomes
        priceMarket {
          openTime
          closeTime
          resolved
          outcome
          finalPrice
          strikePrice
        }
      }
    }
  }
`;

/**
 * Get recent trades across all venues (for activity feed / ticker)
 */
export const GET_RECENT_TRADES = gql`
  query GetRecentTrades($first: Int = 20, $skip: Int = 0) {
    trades(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      market {
        marketId
        question
        outcomes
        venue {
          venueId
          name
        }
      }
      outcome
      tick
      amount
      cost
      tradeType
      buyTrader {
        id
      }
      sellTrader {
        id
      }
      timestamp
      blockNumber
      transactionHash
    }
  }
`;

/**
 * Get recently created markets across all venues
 */
export const GET_RECENT_MARKETS = gql`
  query GetRecentMarkets($first: Int = 20, $skip: Int = 0) {
    markets(
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
      where: { status_not: "Draft" }
    ) {
      id
      marketId
      question
      outcomes
      status
      totalVolume
      uniqueTraders
      createdAt
      venue {
        venueId
        name
      }
      creator {
        address
      }
    }
  }
`;

// ============================================
// Trader Analytics Queries
// ============================================

export const GET_TRADER_PROFILE = gql`
  query GetTraderProfile($address: ID!) {
    user(id: $address) {
      id
      address
      totalOrdersPlaced
      totalVolume
      totalTradeCount
      totalMarketsTraded
      totalRealizedPnL
      totalMarkets
      totalMarketGroups
      firstSeenAt
      lastSeenAt
    }
  }
`;

export const GET_TRADER_POSITIONS = gql`
  query GetTraderPositions(
    $trader: String!
    $first: Int = 100
    $skip: Int = 0
  ) {
    traderPositions(
      where: { trader: $trader, quantity_gt: "0" }
      first: $first
      skip: $skip
      orderBy: lastTradeAt
      orderDirection: desc
    ) {
      id
      outcome
      quantity
      totalCostBasis
      avgEntryPrice
      realizedPnL
      totalCollateralIn
      totalCollateralOut
      buyCount
      sellCount
      firstTradeAt
      lastTradeAt
      market {
        id
        marketId
        question
        outcomes
        status
        resolvedOutcome
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_TRADER_CLOSED_POSITIONS = gql`
  query GetTraderClosedPositions(
    $trader: String!
    $first: Int = 100
    $skip: Int = 0
  ) {
    traderPositions(
      where: { trader: $trader, quantity: "0" }
      first: $first
      skip: $skip
      orderBy: lastTradeAt
      orderDirection: desc
    ) {
      id
      outcome
      quantity
      totalCostBasis
      avgEntryPrice
      realizedPnL
      totalCollateralIn
      totalCollateralOut
      buyCount
      sellCount
      firstTradeAt
      lastTradeAt
      market {
        id
        marketId
        question
        outcomes
        status
        resolvedOutcome
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_TRADER_FILLS = gql`
  query GetTraderFills(
    $trader: String!
    $first: Int = 50
    $skip: Int = 0
  ) {
    fills(
      where: { trader: $trader }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      outcome
      side
      tick
      amount
      cost
      fees
      tradeType
      avgPrice
      timestamp
      blockNumber
      transactionHash
      market {
        id
        marketId
        question
        outcomes
        tickSize
        status
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_LEADERBOARD = gql`
  query GetLeaderboard(
    $orderBy: User_orderBy = totalVolume
    $orderDirection: OrderDirection = desc
    $first: Int = 50
    $skip: Int = 0
  ) {
    users(
      where: { totalTradeCount_gt: "0" }
      first: $first
      skip: $skip
      orderBy: $orderBy
      orderDirection: $orderDirection
    ) {
      id
      address
      totalVolume
      totalTradeCount
      totalMarketsTraded
      totalRealizedPnL
      firstSeenAt
      lastSeenAt
    }
  }
`;

// ============================================
// Venue-Scoped Trader Analytics Queries
// ============================================

export const GET_TRADER_VENUE_PROFILE = gql`
  query GetTraderVenueProfile($id: ID!) {
    userVenueStat(id: $id) {
      id
      totalOrdersPlaced
      totalVolume
      totalTradeCount
      totalMarketsTraded
      totalRealizedPnL
      firstSeenAt
      lastSeenAt
      trader {
        id
        address
      }
    }
  }
`;

export const GET_VENUE_LEADERBOARD = gql`
  query GetVenueLeaderboard(
    $venueId: BigInt!
    $orderBy: UserVenueStat_orderBy = totalVolume
    $orderDirection: OrderDirection = desc
    $first: Int = 50
    $skip: Int = 0
  ) {
    userVenueStats(
      where: { venue_: { venueId: $venueId }, totalTradeCount_gt: "0" }
      first: $first
      skip: $skip
      orderBy: $orderBy
      orderDirection: $orderDirection
    ) {
      id
      totalVolume
      totalTradeCount
      totalMarketsTraded
      totalRealizedPnL
      firstSeenAt
      lastSeenAt
      trader {
        id
        address
      }
    }
  }
`;

export const GET_TRADER_VENUE_POSITIONS = gql`
  query GetTraderVenuePositions(
    $trader: String!
    $venueId: BigInt!
    $first: Int = 100
    $skip: Int = 0
  ) {
    traderPositions(
      where: {
        trader: $trader
        venue_: { venueId: $venueId }
        quantity_gt: "0"
      }
      first: $first
      skip: $skip
      orderBy: lastTradeAt
      orderDirection: desc
    ) {
      id
      outcome
      quantity
      totalCostBasis
      avgEntryPrice
      realizedPnL
      totalCollateralIn
      totalCollateralOut
      buyCount
      sellCount
      firstTradeAt
      lastTradeAt
      market {
        id
        marketId
        question
        outcomes
        status
        resolvedOutcome
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_TRADER_VENUE_CLOSED_POSITIONS = gql`
  query GetTraderVenueClosedPositions(
    $trader: String!
    $venueId: BigInt!
    $first: Int = 100
    $skip: Int = 0
  ) {
    traderPositions(
      where: {
        trader: $trader
        venue_: { venueId: $venueId }
        quantity: "0"
      }
      first: $first
      skip: $skip
      orderBy: lastTradeAt
      orderDirection: desc
    ) {
      id
      outcome
      quantity
      totalCostBasis
      avgEntryPrice
      realizedPnL
      totalCollateralIn
      totalCollateralOut
      buyCount
      sellCount
      firstTradeAt
      lastTradeAt
      market {
        id
        marketId
        question
        outcomes
        status
        resolvedOutcome
        tickSize
        lastPriceTick_0
        lastPriceTick_1
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_TRADER_VENUE_FILLS = gql`
  query GetTraderVenueFills(
    $trader: String!
    $venueId: BigInt!
    $first: Int = 50
    $skip: Int = 0
  ) {
    fills(
      where: {
        trader: $trader
        venue_: { venueId: $venueId }
      }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      outcome
      side
      tick
      amount
      cost
      fees
      tradeType
      avgPrice
      timestamp
      blockNumber
      transactionHash
      market {
        id
        marketId
        question
        outcomes
        tickSize
        status
        collateralDecimals
        venue {
          id
          venueId
          name
        }
      }
    }
  }
`;

export const GET_MARKET_TOP_HOLDERS = gql`
  query GetMarketTopHolders(
    $marketId: String!
    $first: Int = 20
  ) {
    traderPositions(
      where: { market: $marketId, quantity_gt: "0" }
      first: $first
      orderBy: quantity
      orderDirection: desc
    ) {
      id
      trader {
        id
        address
      }
      outcome
      quantity
      totalCostBasis
      avgEntryPrice
      realizedPnL
    }
  }
`;

// ============================================
// DPM (Dynamic Pari-Mutuel) Markets
// ============================================

export const GET_DPM_MARKET = gql`
  query GetDpmMarket($id: ID!) {
    dpmMarket(id: $id) {
      id
      outcomeCount
      openTime
      closeTime
      poolInitialized
      seededAt
      resolved
      winningOutcome
      resolvedAt
      totalCollateral
      totalShares
      totalIntent
      totalClaimed
      uniqueTraders
      createdAt
      updatedAt
      market {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        conditionId
        tags
        metadataURI
      }
      outcomes(orderBy: outcomeIndex, orderDirection: asc) {
        outcomeIndex
        label
        conditionId
        collateral
        shares
        intentTotal
        isWinner
        addedLate
      }
    }
  }
`;

export const GET_DPM_MARKETS = gql`
  query GetDpmMarkets($first: Int = 100, $skip: Int = 0) {
    dpmMarkets(
      first: $first
      skip: $skip
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      outcomeCount
      openTime
      closeTime
      poolInitialized
      resolved
      winningOutcome
      totalCollateral
      totalShares
      uniqueTraders
      createdAt
      market {
        id
        marketId
        question
        outcomes
        status
        collateralToken
        tags
        venue {
          id
          venueId
        }
      }
      outcomes(orderBy: outcomeIndex, orderDirection: asc) {
        outcomeIndex
        label
        collateral
        shares
      }
    }
  }
`;

export const GET_DPM_POSITIONS = gql`
  query GetDpmPositions($marketId: String!, $first: Int = 100, $skip: Int = 0) {
    dpmPositions(
      where: { dpmMarket: $marketId }
      first: $first
      skip: $skip
      orderBy: shares
      orderDirection: desc
    ) {
      id
      outcomeIndex
      shares
      intentStake
      collateralIn
      entryCount
      claimed
      payout
      realizedPnL
      firstSeenAt
      lastUpdatedAt
      trader {
        id
        address
      }
      outcome {
        label
      }
    }
  }
`;

export const GET_USER_DPM_POSITIONS = gql`
  query GetUserDpmPositions($trader: String!, $first: Int = 100, $skip: Int = 0) {
    dpmPositions(
      where: { trader: $trader }
      first: $first
      skip: $skip
      orderBy: lastUpdatedAt
      orderDirection: desc
    ) {
      id
      outcomeIndex
      shares
      intentStake
      collateralIn
      claimed
      payout
      realizedPnL
      lastUpdatedAt
      outcome {
        label
      }
      dpmMarket {
        id
        resolved
        winningOutcome
        poolInitialized
        market {
          marketId
          question
          outcomes
          status
        }
      }
    }
  }
`;
