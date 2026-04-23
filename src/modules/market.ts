import { BaseModule } from './base';
import {
  VenueFacetABI,
  MarketsFacetABI,
  MarketGroupFacetABI,
  OrderBookFacetABI,
  NegRiskFacetABI,
  ConditionalTokensABI,
  TagsFacetABI,
  MetadataFacetABI,
} from '../contracts';
import { erc20Abi, stringToHex } from 'viem';
import type { Address } from 'viem';
import { formatAmount, isValidTickSize, type MarketQuestion } from '../utils/conversions';
import { getTokenDecimals } from '../utils/decimals';

// Inline fragment for ERC-1155 isApprovedForAll. Not in the bundled CTF ABI
// because it was generated from a subset of methods; this avoids having to
// regenerate the full ABI for a single standard read.
const CTF_IS_APPROVED_FOR_ALL_ABI = [
  {
    name: 'isApprovedForAll',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export class MarketModule extends BaseModule {
  /**
   * Format market question into UMA-compliant ancillary data
   * @param question Structured market question with title and description
   * @returns Hex-encoded ancillary data bytes
   * @private
   */
  private formatAncillaryData(question: MarketQuestion): `0x${string}` {
    // Build comma-delimited key:value format (start with "q:" prefix)
    let data = `q:title:${question.title}`;
    data += `,description:${question.description}`;

    // Convert to hex bytes
    return stringToHex(data);
  }

  /**
   * Create a new market
   *
   * IMPORTANT: All bigint amounts must use the collateral token's decimals!
   * - For USDC (6 decimals): Use parseAmount("10", 6) or parseUnits("10", 6)
   * - For 18-decimal tokens: Use parseAmount("10") or parseEther("10")
   *
   * @param params.tickSize - Price increment (typically parseEther("0.01") = 0.01 per tick)
   * @param params.additionalReward - Extra UMA reward in collateral token units (with token decimals!)
   * @param params.liveness - Challenge period in seconds (0 = use 2-hour default)
   */
  async createMarket(params: {
    venueId: bigint;
    question: MarketQuestion;
    outcomes: string[];
    tickSize: bigint;
    collateralToken: Address;
    additionalReward: bigint;
    liveness?: bigint;
    tags?: string[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();
    const accountAddress = await this.getSignerAddress();

    // Pre-flight checks: Market creation fee is determined by venue configuration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const venue: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'getVenue',
      args: [params.venueId],
    });

    const feeRequired = BigInt(venue.marketCreationFee);
    const reward = BigInt(venue.umaRewardAmount) + (params.additionalReward ?? 0n);
    const totalRequired = feeRequired + reward;

    if (totalRequired > 0n) {
      const allowance = await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [accountAddress, this.config.diamondAddress],
      });

      if (allowance < totalRequired) {
        throw new Error(
          `Insufficient allowance. Approved: ${allowance.toString()}, Required: ${totalRequired.toString()} (fee: ${feeRequired.toString()}, reward: ${reward.toString()}). Please approve the Diamond (${
            this.config.diamondAddress
          }).`,
        );
      }

      const balance = await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddress],
      });

      if (balance < totalRequired) {
        throw new Error(
          `Insufficient collateral balance. Have: ${balance.toString()}, Required: ${totalRequired.toString()} (fee: ${feeRequired.toString()}, reward: ${reward.toString()}).`,
        );
      }
    }

    if (!isValidTickSize(params.tickSize)) {
      throw new Error('Invalid tickSize: must be 1e15 (0.1%) or 1e16 (1%)');
    }

    // Format ancillary data
    const ancillaryData = this.formatAncillaryData(params.question);

    // Encode tags as bytes32[]
    const encodedTags = (params.tags ?? []).map((t) =>
      stringToHex(t, { size: 32 }),
    );

    // Create market (Diamond dropped alpha param)
    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'createMarket',
      args: [
        params.venueId,
        ancillaryData,
        params.outcomes,
        params.tickSize,
        params.collateralToken,
        params.additionalReward,
        params.liveness ?? 0n,
        encodedTags,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get market registry data (lifecycle, venue, creator, status)
   */
  async getMarketRegistryData(marketId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketRegistryData',
      args: [marketId],
    });
  }

  /**
   * Get market trading data (positionIds, volume, lastTradeTick, tickSize, collateral)
   */
  async getMarketTradingData(marketId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [marketId],
    });
  }

  /**
   * Get market oracle data (questionId, conditionId, UMA economics)
   */
  async getMarketOracleData(marketId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketOracleData',
      args: [marketId],
    });
  }

  /**
   * Calculate Position ID for a market outcome (for CTF balance queries)
   */
  async getPositionId(marketId: bigint, outcomeIndex: bigint): Promise<bigint> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.getMarketTradingData(marketId);

    const ids = tradingData.positionIds;
    if (!ids || ids.length <= Number(outcomeIndex)) {
      throw new Error('Position ID not found in trading data');
    }

    return BigInt(ids[Number(outcomeIndex)]);
  }

  /**
   * Get best prices (Top of Book) for all outcomes
   * Returns the raw tick values.
   */
  async getBestPrices(marketId: bigint) {
    const getTick = async (outcome: number, side: number) => {
      return (await this.publicClient.readContract({
        address: this.config.diamondAddress,
        abi: OrderBookFacetABI,
        functionName: 'getTopOfBook',
        args: [marketId, BigInt(outcome), side],
      })) as bigint;
    };

    // Fetch relevant ticks: YES Ask, YES Bid, NO Ask, NO Bid
    const [yesAsk, yesBid, noAsk, noBid] = await Promise.all([
      getTick(0, 1), // YES Ask
      getTick(0, 0), // YES Bid
      getTick(1, 1), // NO Ask
      getTick(1, 0), // NO Bid
    ]);

    return {
      yesAsk,
      yesBid,
      noAsk,
      noBid,
    };
  }

  /**
   * Get user's outcome token balances for a market
   * @param params.formatted - If true, returns decimal strings instead of BigInt (recommended for frontends)
   *
   * @dev Outcome tokens use the same decimals as the collateral token.
   * CTF inherits decimals from the underlying collateral.
   */
  async getUserBalances(
    marketId: bigint,
    user: Address,
    params?: { formatted?: boolean },
  ) {
    const formatted = params?.formatted ?? false;

    // Get market trading data to determine collateral token
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.getMarketTradingData(marketId);
    const collateralToken = tradingData.collateralToken as Address;

    // Get collateral decimals
    const decimals = await getTokenDecimals(this.publicClient, collateralToken);

    const yesPositionId = await this.getPositionId(marketId, 0n);
    const noPositionId = await this.getPositionId(marketId, 1n);

    const [yesBalance, noBalance] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.conditionalTokensAddress,
        abi: ConditionalTokensABI,
        functionName: 'balanceOf',
        args: [user, yesPositionId],
      }),
      this.publicClient.readContract({
        address: this.config.conditionalTokensAddress,
        abi: ConditionalTokensABI,
        functionName: 'balanceOf',
        args: [user, noPositionId],
      }),
    ]);

    if (formatted) {
      return {
        YES: formatAmount(yesBalance as bigint, decimals),
        NO: formatAmount(noBalance as bigint, decimals),
      };
    }

    return {
      YES: yesBalance as bigint,
      NO: noBalance as bigint,
    };
  }

  /**
   * Get market prices directly from on-chain data (RPC)
   * This bypasses the subgraph for guaranteed fresh pricing
   *
   * Uses mark price from the orderbook (mid-point of best bid/ask)
   * Falls back to last trade tick if no orderbook liquidity
   *
   * Returns prices in decimal format (e.g., "0.80" for 80%)
   */
  async getMarketPricesRPC(marketId: bigint) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tradingData: any = await this.getMarketTradingData(marketId);
      const tickSize = BigInt(tradingData.tickSize);

      // Try mark price first (orderbook mid-point)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [markPrice0, markPrice1]: any[] = await Promise.all([
        this.publicClient.readContract({
          address: this.config.diamondAddress,
          abi: OrderBookFacetABI,
          functionName: 'getMarkPrice',
          args: [marketId, 0n],
        }),
        this.publicClient.readContract({
          address: this.config.diamondAddress,
          abi: OrderBookFacetABI,
          functionName: 'getMarkPrice',
          args: [marketId, 1n],
        }),
      ]);

      // getMarkPrice returns (priceTick, isDefined)
      const tick0 = BigInt(markPrice0[0]);
      const isDefined0 = markPrice0[1] as boolean;
      const tick1 = BigInt(markPrice1[0]);
      const isDefined1 = markPrice1[1] as boolean;

      if (isDefined0 || isDefined1) {
        const price0Raw = tick0 * tickSize;
        const price1Raw = tick1 * tickSize;
        const yesPrice = isDefined0 ? (Number(price0Raw) / 1e18).toFixed(2) : '0.50';
        const noPrice = isDefined1 ? (Number(price1Raw) / 1e18).toFixed(2) : '0.50';

        return {
          YES: yesPrice,
          NO: noPrice,
          source: 'rpc' as const,
          volume: {
            YES: tradingData.totalVolume[0].toString(),
            NO: tradingData.totalVolume[1].toString(),
          },
          timestamp: Date.now(),
        };
      }

      // Fallback: use last trade ticks
      const lastTick0 = BigInt(tradingData.lastTradeTick[0]);
      const lastTick1 = BigInt(tradingData.lastTradeTick[1]);

      if (lastTick0 > 0n || lastTick1 > 0n) {
        const yesPrice = lastTick0 > 0n
          ? (Number(lastTick0 * tickSize) / 1e18).toFixed(2)
          : '0.50';
        const noPrice = lastTick1 > 0n
          ? (Number(lastTick1 * tickSize) / 1e18).toFixed(2)
          : '0.50';

        return {
          YES: yesPrice,
          NO: noPrice,
          source: 'rpc' as const,
          volume: {
            YES: tradingData.totalVolume[0].toString(),
            NO: tradingData.totalVolume[1].toString(),
          },
          timestamp: Date.now(),
        };
      }

      // Default
      return {
        YES: '0.50',
        NO: '0.50',
        source: 'default' as const,
        volume: { YES: '0', NO: '0' },
        timestamp: null,
      };
    } catch (error) {
      console.error('[SDK] RPC price fetch error:', error);
      return {
        YES: '0.50',
        NO: '0.50',
        source: 'default' as const,
        volume: { YES: '0', NO: '0' },
        timestamp: null,
      };
    }
  }

  // ============================================
  // Market Groups
  // ============================================

  /**
   * Create a new market group (parent metadata only, no markets yet)
   *
   * @param params.question - Market question (e.g., "Where will Giannis be traded?")
   * @param params.description - Resolution criteria (shared by all markets)
   * @param params.collateralToken - Collateral token for all markets in group
   * @param params.tickSize - Price increment (same for all markets)
   * @param params.additionalReward - Additional UMA reward in collateral token units
   * @param params.liveness - Challenge period in seconds (0 = use 2-hour default)
   * @returns Transaction hash
   */
  async createMarketGroup(params: {
    venueId: bigint;
    question: string;
    description: string;
    collateralToken: Address;
    tickSize: bigint;
    additionalReward: bigint;
    liveness?: bigint;
    tags?: string[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();
    const accountAddress = await this.getSignerAddress();

    // Pre-flight checks: Market creation fee (same as regular market)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const venue: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'getVenue',
      args: [params.venueId],
    });

    const feeRequired = BigInt(venue.marketCreationFee);
    const reward = BigInt(venue.umaRewardAmount) + (params.additionalReward ?? 0n);
    const totalRequired = feeRequired + reward;

    if (totalRequired > 0n) {
      const allowance = await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [accountAddress, this.config.diamondAddress],
      });

      if (allowance < totalRequired) {
        throw new Error(
          `Insufficient allowance. Approved: ${allowance.toString()}, Required: ${totalRequired.toString()} (fee: ${feeRequired.toString()}, reward: ${reward.toString()}). Please approve the Diamond (${
            this.config.diamondAddress
          }).`,
        );
      }

      const balance = await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddress],
      });

      if (balance < totalRequired) {
        throw new Error(
          `Insufficient collateral balance. Have: ${balance.toString()}, Required: ${totalRequired.toString()} (fee: ${feeRequired.toString()}, reward: ${reward.toString()}).`,
        );
      }
    }

    if (!isValidTickSize(params.tickSize)) {
      throw new Error('Invalid tickSize: must be 1e15 (0.1%) or 1e16 (1%)');
    }

    // Encode tags as bytes32[]
    const groupTags = (params.tags ?? []).map((t) =>
      stringToHex(t, { size: 32 }),
    );

    // Create market group (Diamond dropped alpha param)
    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'createMarketGroup',
      args: [
        params.venueId,
        params.question,
        params.description,
        params.collateralToken,
        params.tickSize,
        params.additionalReward,
        params.liveness ?? 0n,
        groupTags,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Add a market to a Draft market group
   */
  async addMarketToGroup(params: {
    marketGroupId: bigint;
    marketName: string;
    marketQuestion: string;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'addMarket',
      args: [params.marketGroupId, params.marketName, params.marketQuestion],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Add placeholder markets to a Draft market group
   */
  async addPlaceholderMarkets(params: {
    marketGroupId: bigint;
    count: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    if (params.count < 1n || params.count > 50n) {
      throw new Error('Count must be between 1 and 50');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'addPlaceholderMarkets',
      args: [params.marketGroupId, params.count],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Activate a placeholder market with real question
   */
  async activatePlaceholder(params: {
    marketGroupId: bigint;
    marketId: bigint;
    marketName: string;
    marketQuestion: string;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'activatePlaceholder',
      args: [
        params.marketGroupId,
        params.marketId,
        params.marketName,
        params.marketQuestion,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Activate a market group (locks totalMarkets, enables trading)
   */
  async activateMarketGroup(params: { marketGroupId: bigint }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'activateMarketGroup',
      args: [params.marketGroupId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Convert NO positions to complementary YES positions + collateral
   *
   * Formula: N NO positions → (M-N) YES positions + (N-1) collateral
   */
  async convertPositions(params: {
    marketGroupId: bigint;
    indexSet: bigint;
    amount: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();
    const accountAddress = await this.getSignerAddress();

    // Check CTF approval for Diamond
    const isApproved = await this.publicClient.readContract({
      address: this.config.conditionalTokensAddress,
      abi: CTF_IS_APPROVED_FOR_ALL_ABI,
      functionName: 'isApprovedForAll',
      args: [accountAddress, this.config.diamondAddress],
    });

    if (!isApproved) {
      throw new Error(
        `CTF tokens not approved for Diamond. Please call: ctf.setApprovalForAll("${this.config.diamondAddress}", true)`,
      );
    }

    // Get group data to extract conditionIds and collateralToken
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groupData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'getMarketGroup',
      args: [params.marketGroupId],
    });

    // Get conditionIds for all markets in the group
    const marketIds: bigint[] = groupData.marketIds;
    const conditionIds: `0x${string}`[] = [];
    for (const mid of marketIds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oracleData: any = await this.getMarketOracleData(mid);
      conditionIds.push(oracleData.conditionId);
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: NegRiskFacetABI,
      functionName: 'convertPositions',
      args: [conditionIds, groupData.collateralToken, params.indexSet, params.amount],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get market group data
   */
  async getMarketGroup(marketGroupId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'getMarketGroup',
      args: [marketGroupId],
    });
  }

  /**
   * Get all market IDs in a group
   */
  async getGroupMarketIds(marketGroupId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'getGroupMarketIds',
      args: [marketGroupId],
    });
  }

  /**
   * Get market group item data (group-specific metadata)
   */
  async getMarketGroupItem(marketId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketGroupFacetABI,
      functionName: 'getMarketGroupItem',
      args: [marketId],
    });
  }

  /**
   * Get market prices using subgraph data with orderbook fallback
   *
   * Price hierarchy:
   * 1. Last trade price (from Normal fills or Market orders)
   * 2. Orderbook-derived price (best execution cost)
   * 3. Default 50/50 (no information)
   */
  async getMarketPrices(marketId: bigint) {
    // Fetch market data from subgraph
    const query = `
      query GetMarketPrices($marketId: BigInt!) {
        markets(where: { marketId: $marketId }) {
          tickSize
          lastPriceTick_0
          lastPriceTick_1
          lastTradeTimestamp
        }
      }
    `;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await this.subgraph.request(query, {
      marketId: marketId.toString(),
    });
    const market = result.markets?.[0];

    if (!market) {
      return {
        YES: '0.50',
        NO: '0.50',
        source: 'default' as const,
        timestamp: null,
      };
    }

    // Priority 1: Use last trade prices
    const hasLastPrices = market?.lastPriceTick_0 || market?.lastPriceTick_1;
    const tickSize = BigInt(market.tickSize || '10000000000000000');

    if (hasLastPrices) {
      let yesPrice = 0.5;
      let noPrice = 0.5;

      if (market.lastPriceTick_0 && market.lastPriceTick_0 !== '0') {
        const yesPriceBigInt = BigInt(market.lastPriceTick_0) * tickSize;
        yesPrice = Number(yesPriceBigInt) / 1e18;
        noPrice = 1 - yesPrice;
      } else if (market.lastPriceTick_1 && market.lastPriceTick_1 !== '0') {
        const noPriceBigInt = BigInt(market.lastPriceTick_1) * tickSize;
        noPrice = Number(noPriceBigInt) / 1e18;
        yesPrice = 1 - noPrice;
      }

      return {
        YES: yesPrice.toFixed(2),
        NO: noPrice.toFixed(2),
        source: 'trade' as const,
        timestamp: market.lastTradeTimestamp,
      };
    }

    // Priority 2: Derive from orderbook (best execution cost for buyers)
    const { yesAsk, yesBid, noAsk, noBid } = await this.getBestPrices(marketId);

    const hasOrderbook = yesAsk > 0n || yesBid > 0n || noAsk > 0n || noBid > 0n;

    if (hasOrderbook) {
      const calcBuyPrice = (
        bestAsk: bigint,
        complementBestBid: bigint,
      ): number => {
        if (bestAsk > 0n) {
          return Number(bestAsk * tickSize) / 1e18;
        }
        if (complementBestBid > 0n) {
          const bidPrice = Number(complementBestBid * tickSize) / 1e18;
          return 1 - bidPrice;
        }
        return 0.5;
      };

      const yesPrice = calcBuyPrice(yesAsk, noBid);
      const noPrice = calcBuyPrice(noAsk, yesBid);

      return {
        YES: yesPrice.toFixed(2),
        NO: noPrice.toFixed(2),
        source: 'orderbook' as const,
        timestamp: null,
      };
    }

    // Priority 3: Default (no information available)
    return {
      YES: '0.50',
      NO: '0.50',
      source: 'default' as const,
      timestamp: null,
    };
  }

  // ============================================
  // Market Moderation
  // ============================================

  /**
   * Pause a market. Blocks trading but allows order cancellations.
   * Only the venue operator can call this.
   */
  async pauseMarket(marketId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'pauseMarket',
      args: [marketId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Unpause a market. Resumes trading.
   * Only the venue operator can call this.
   */
  async unpauseMarket(marketId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'unpauseMarket',
      args: [marketId],
      account,
    });

    return wallet.writeContract(request);
  }

  // ============================================
  // Tags
  // ============================================

  /**
   * Update tags for a standalone market (event-only, no storage)
   * Only the market creator can call this.
   */
  async updateMarketTags(params: {
    marketId: bigint;
    tags: string[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const encodedTags = params.tags.map((t) =>
      stringToHex(t, { size: 32 }),
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: TagsFacetABI,
      functionName: 'updateMarketTags',
      args: [params.marketId, encodedTags],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Update tags for a market group (event-only, no storage)
   * Only the group creator can call this.
   */
  async updateMarketGroupTags(params: {
    marketGroupId: bigint;
    tags: string[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const encodedTags = params.tags.map((t) =>
      stringToHex(t, { size: 32 }),
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: TagsFacetABI,
      functionName: 'updateMarketGroupTags',
      args: [params.marketGroupId, encodedTags],
      account,
    });

    return wallet.writeContract(request);
  }

  // ============================================
  // Metadata
  // ============================================

  /**
   * Update metadata URI for a standalone market (event-only, no storage)
   * Only the market creator can call this.
   */
  async updateMarketMetadata(params: {
    marketId: bigint;
    metadataURI: string;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MetadataFacetABI,
      functionName: 'updateMarketMetadata',
      args: [params.marketId, params.metadataURI],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Update metadata URI for a market group (event-only, no storage)
   * Only the group creator can call this.
   */
  async updateMarketGroupMetadata(params: {
    marketGroupId: bigint;
    metadataURI: string;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MetadataFacetABI,
      functionName: 'updateMarketGroupMetadata',
      args: [params.marketGroupId, params.metadataURI],
      account,
    });

    return wallet.writeContract(request);
  }
}
