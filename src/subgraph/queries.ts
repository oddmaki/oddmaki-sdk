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
  query GetMarkets($venueId: BigInt, $first: Int = 100, $skip: Int = 0) {
    markets(
      where: { venue_: { venueId: $venueId } }
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
      tags
      metadataURI
    }
  }
`;

export const GET_MARKETS_WITH_PRICING = gql`
  query GetMarketsWithPricing(
    $venueId: BigInt
    $first: Int = 100
    $skip: Int = 0
  ) {
    markets(
      where: { venue_: { venueId: $venueId } }
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
    # Standalone binary markets (not in groups)
    standaloneMarkets: markets(
      where: { groupId: "0", venue_: { venueId: $venueId }, status_not: "Draft" }
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
    # Standalone binary markets sorted by volume
    standaloneMarkets: markets(
      where: { groupId: "0", venue_: { venueId: $venueId }, status_not: "Draft" }
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
      lastPriceTick_0
      lastPriceTick_1
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
      tags
      metadataURI
      resolvedMarketId
      createdAt
      venue {
        id
        venueId
        name
      }
      markets {
        marketId
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
    # Standalone binary markets (not in groups)
    standaloneMarkets: markets(
      where: { groupId: "0", status_not: "Draft" }
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
  }
`;

/**
 * Get all markets across all venues sorted by volume
 */
export const GET_ALL_MARKETS_FEED_BY_VOLUME = gql`
  query GetAllMarketsFeedByVolume($first: Int = 50, $skip: Int = 0) {
    standaloneMarkets: markets(
      where: { groupId: "0", status_not: "Draft" }
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
      lastPriceTick_0
      lastPriceTick_1
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
      metadataURI
      resolvedMarketId
      createdAt
      venue {
        id
        venueId
        name
      }
      markets {
        marketId
        lastPriceTick_0
        lastPriceTick_1
        totalVolume
        marketGroupItem {
          marketName
          isPlaceholder
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
