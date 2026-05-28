import { BaseModule } from './base';
import {
  LimitOrdersFacetABI,
  MatchingFacetABI,
  OrderBookFacetABI,
  MarketOrdersFacetABI,
  MarketsFacetABI,
  VaultFacetABI,
  BatchOrdersFacetABI,
} from '../contracts';
import {
  tickToPrice,
  formatAmount,
  priceToTick,
  parseAmount,
  createExpiry,
} from '../utils/conversions';
import { getCachedTokenDecimals, parseTokenAmount } from '../utils/decimals';
import { slippagePctToBps } from '../utils/feeAwarePricing';
import type { Address } from 'viem';

export class TradeModule extends BaseModule {
  /**
   * Place a limit order
   * Use placeOrderSimple() for string-based inputs (recommended for frontends)
   */
  async placeOrder(params: {
    marketId: bigint;
    outcomeId: bigint;
    side: number; // 0 = BUY, 1 = SELL
    tick: bigint;
    qty: bigint;
    expiry: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'placeOrder',
      args: [
        params.marketId,
        params.outcomeId,
        params.side,
        params.tick,
        params.qty,
        params.expiry,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Place a limit order with simple string inputs (recommended for frontends)
   * @param params.price - Price as decimal string (e.g., "0.75")
   * @param params.quantity - Quantity as decimal string (e.g., "100.5")
   * @param params.expiry - Expiry as duration string (e.g., "1h", "24h") or bigint timestamp
   *
   * NOTE: Outcome token amounts use the same decimals as the collateral token
   * (e.g., 6 for USDC) because splitPosition creates tokens 1:1 with collateral.
   */
  async placeOrderSimple(params: {
    marketId: bigint;
    outcomeId: bigint;
    side: number;
    price: string;
    quantity: string;
    expiry: string | bigint;
  }) {
    // Read market trading data to get collateral token decimals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [params.marketId],
    });

    const collateralToken = tradingData.collateralToken as Address;
    const decimals = await getCachedTokenDecimals(this.publicClient, collateralToken);

    const tick = priceToTick(params.price);
    const qty = parseTokenAmount(params.quantity, decimals);

    const expiry =
      typeof params.expiry === 'string'
        ? (params.expiry === 'gtc' ? BigInt(0) : createExpiry(params.expiry))
        : params.expiry;

    return this.placeOrder({
      marketId: params.marketId,
      outcomeId: params.outcomeId,
      side: params.side,
      tick,
      qty,
      expiry,
    });
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'cancelOrder',
      args: [orderId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Cancel all remaining orders on a resolved market in a single transaction.
   * Regular cancelOrder / batchCancelOrders revert once the market is no longer
   * active, so this is the only way to clear stale orders post-resolution.
   * @param marketId - The resolved market
   * @param orderIds - Order IDs to cancel (must belong to caller)
   */
  async cancelOrdersOnResolvedMarket(marketId: bigint, orderIds: bigint[]) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'cancelOrdersOnResolvedMarket',
      args: [marketId, orderIds],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Place a multi-path market BUY. Walks the same-outcome SELL book and the
   * opposite-outcome BUY book (via mint-fill) in parallel, taking the cheapest
   * crossable path per step. Slippage is anchored to the on-chain mark price
   * at facet entry — no caller-supplied price.
   *
   * @param params.budget       - Collateral budget the taker is willing to spend (in token decimals)
   * @param params.slippageBps  - Maximum slippage above the resolved mark tick (bps; max 2000 = 20%)
   * @param params.orderType    - 0=FOK (Fill-Or-Kill), 1=FAK (Fill-And-Kill)
   */
  async placeMarketBuy(params: {
    marketId: bigint;
    outcomeId: bigint;
    budget: bigint;
    slippageBps: bigint;
    orderType: number; // 0 = FOK, 1 = FAK
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketBuy',
      args: [
        params.marketId,
        params.outcomeId,
        params.budget,
        params.slippageBps,
        params.orderType,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Place a market BUY with frontend-friendly string inputs.
   *
   * @param params.amount       - Collateral budget as decimal string (e.g., "10.5")
   * @param params.slippagePct  - Slippage tolerance as percent (number or string;
   *                              "5" or 5 → 500 bps). Capped at 20.
   * @param params.orderType    - 'FOK' or 'FAK' (default: 'FAK')
   */
  async placeMarketBuySimple(params: {
    marketId: bigint;
    outcomeId: bigint;
    amount: string;
    slippagePct: number | string;
    orderType?: 'FOK' | 'FAK';
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [params.marketId],
    });

    const collateralToken = tradingData.collateralToken as Address;
    const decimals = await getCachedTokenDecimals(this.publicClient, collateralToken);
    const budget = parseTokenAmount(params.amount, decimals);
    const slippageBps = slippagePctToBps(params.slippagePct);
    const orderType = params.orderType === 'FOK' ? 0 : 1;

    return this.placeMarketBuy({
      marketId: params.marketId,
      outcomeId: params.outcomeId,
      budget,
      slippageBps,
      orderType,
    });
  }

  /**
   * Simulate a market BUY (returns the would-be on-chain result without
   * broadcasting). Useful for dry-runs and preflight checks.
   */
  async previewMarketBuy(params: {
    marketId: bigint;
    outcomeId: bigint;
    budget: bigint;
    slippageBps: bigint;
    orderType: number;
  }) {
    const account = await this.getSignerAccount();

    const { result } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketBuy',
      args: [
        params.marketId,
        params.outcomeId,
        params.budget,
        params.slippageBps,
        params.orderType,
      ],
      account,
    });

    return result;
  }

  /**
   * Preview placing an order (simulate transaction to check for reverts)
   */
  async previewPlaceOrder(params: {
    marketId: bigint;
    outcomeId: bigint;
    side: number;
    tick: bigint;
    qty: bigint;
    expiry: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { result } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'placeOrder',
      args: [
        params.marketId,
        params.outcomeId,
        params.side,
        params.tick,
        params.qty,
        params.expiry,
      ],
      account,
    });

    return result;
  }

  /**
   * Place a multi-path market SELL. Walks the same-outcome BUY book and the
   * opposite-outcome SELL book (via merge-fill) in parallel, taking the path
   * with the highest net taker tick per step. Slippage anchored to the on-chain
   * mark price.
   *
   * @param params.tokenAmount  - Outcome tokens to sell (in token decimals)
   * @param params.slippageBps  - Maximum slippage below the resolved mark tick (bps; max 2000)
   * @param params.orderType    - 0=FOK, 1=FAK
   */
  async placeMarketSell(params: {
    marketId: bigint;
    outcomeId: bigint;
    tokenAmount: bigint;
    slippageBps: bigint;
    orderType: number; // 0 = FOK, 1 = FAK
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketSell',
      args: [
        params.marketId,
        params.outcomeId,
        params.tokenAmount,
        params.slippageBps,
        params.orderType,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Place a market SELL with frontend-friendly string inputs.
   *
   * @param params.amount      - Token amount as decimal string (e.g., "100.5")
   * @param params.slippagePct - Slippage tolerance percent (max 20)
   * @param params.orderType   - 'FOK' or 'FAK' (default: 'FAK')
   */
  async placeMarketSellSimple(params: {
    marketId: bigint;
    outcomeId: bigint;
    amount: string;
    slippagePct: number | string;
    orderType?: 'FOK' | 'FAK';
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [params.marketId],
    });

    const collateralToken = tradingData.collateralToken as Address;
    const decimals = await getCachedTokenDecimals(this.publicClient, collateralToken);
    const tokenAmount = parseTokenAmount(params.amount, decimals);
    const slippageBps = slippagePctToBps(params.slippagePct);
    const orderType = params.orderType === 'FOK' ? 0 : 1;

    return this.placeMarketSell({
      marketId: params.marketId,
      outcomeId: params.outcomeId,
      tokenAmount,
      slippageBps,
      orderType,
    });
  }

  /**
   * Simulate a market SELL.
   */
  async previewMarketSell(params: {
    marketId: bigint;
    outcomeId: bigint;
    tokenAmount: bigint;
    slippageBps: bigint;
    orderType: number;
  }) {
    const account = await this.getSignerAccount();

    const { result } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketSell',
      args: [
        params.marketId,
        params.outcomeId,
        params.tokenAmount,
        params.slippageBps,
        params.orderType,
      ],
      account,
    });

    return result;
  }

  /**
   * Watch for MarketOrderBuy events emitted by market BUY trades.
   */
  watchMarketBuy(
    marketId: bigint,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onLogs: (logs: any[]) => void
  ) {
    return this.publicClient.watchContractEvent({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      eventName: 'MarketOrderBuy',
      args: { marketId },
      onLogs,
    });
  }

  /**
   * Watch for MarketOrderSell events emitted by market SELL trades.
   */
  watchMarketSell(
    marketId: bigint,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onLogs: (logs: any[]) => void
  ) {
    return this.publicClient.watchContractEvent({
      address: this.config.diamondAddress,
      abi: MarketOrdersFacetABI,
      eventName: 'MarketOrderSell',
      args: { marketId },
      onLogs,
    });
  }

  /**
   * Check whether any orders are matchable in the given market.
   * Returns a preview of which fill paths have crossing conditions,
   * plus top-of-book snapshot and head-order expiry flags.
   * Free off-chain (view function) — call before submitting matchOrders txs.
   */
  async canMatchOrders(marketId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: OrderBookFacetABI,
      functionName: 'canMatchOrders',
      args: [marketId],
    });
  }

  /**
   * Manually trigger order matching for a market
   */
  async matchOrders(params: { marketId: bigint; maxSteps?: bigint }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const maxSteps = params.maxSteps || 10n;

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: MatchingFacetABI,
      functionName: 'matchOrders',
      args: [params.marketId, maxSteps],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get order details by ID
   */
  async getOrder(orderId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'getOrder',
      args: [orderId],
    });
  }

  /**
   * Get tick level details (orders at a specific price)
   */
  async getTickLevel(params: {
    marketId: bigint;
    outcomeId: bigint;
    side: number; // 0 = BUY, 1 = SELL
    tick: bigint;
  }) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: OrderBookFacetABI,
      functionName: 'getTickLevel',
      args: [params.marketId, params.outcomeId, params.side, params.tick],
    });
  }

  /**
   * Get top-of-book summary for a market
   * Returns the best bid/ask tick and depth at that level for each outcome
   * @param params.formatted - If true, returns human-readable prices and quantities
   */
  async getOrderBook(params: {
    marketId: bigint;
    formatted?: boolean;
  }) {
    const formatted = params.formatted ?? false;

    const getSide = async (outcomeId: number, side: number) => {
      const topTick = (await this.publicClient.readContract({
        address: this.config.diamondAddress,
        abi: OrderBookFacetABI,
        functionName: 'getTopOfBook',
        args: [params.marketId, BigInt(outcomeId), side],
      })) as bigint;

      if (topTick === 0n) {
        return formatted
          ? { price: '0', quantity: '0', orders: 0, tick: 0n }
          : { tick: 0n, totalQty: 0n, depth: 0n };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const level: any = await this.publicClient.readContract({
        address: this.config.diamondAddress,
        abi: OrderBookFacetABI,
        functionName: 'getTickLevel',
        args: [params.marketId, BigInt(outcomeId), side, topTick],
      });

      if (formatted) {
        return {
          price: tickToPrice(topTick),
          quantity: formatAmount(level.totalQty),
          orders: Number(level.depth),
          tick: topTick,
        };
      }

      return {
        tick: topTick,
        headOrderId: level.headOrderId,
        totalQty: level.totalQty,
        depth: level.depth,
      };
    };

    const [yesBestBid, yesBestAsk, noBestBid, noBestAsk] = await Promise.all([
      getSide(0, 0), // YES Best Bid
      getSide(0, 1), // YES Best Ask
      getSide(1, 0), // NO Best Bid
      getSide(1, 1), // NO Best Ask
    ]);

    return {
      YES: {
        bestBid: yesBestBid,
        bestAsk: yesBestAsk,
      },
      NO: {
        bestBid: noBestBid,
        bestAsk: noBestAsk,
      },
    };
  }

  /**
   * Split collateral into YES + NO outcome tokens
   * Requires USDC approval for the Diamond proxy.
   * @param marketId - The market to split for
   * @param amount - Collateral amount in smallest unit (e.g. USDC with 6 decimals)
   */
  async splitPosition(marketId: bigint, amount: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VaultFacetABI,
      functionName: 'splitPosition',
      args: [marketId, amount],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Merge YES + NO outcome tokens back into collateral
   * Requires CTF setApprovalForAll for the Diamond proxy.
   * @param marketId - The market to merge for
   * @param amount - Amount of each outcome token to merge (in smallest unit)
   */
  async mergePositions(marketId: bigint, amount: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VaultFacetABI,
      functionName: 'mergePositions',
      args: [marketId, amount],
      account,
    });

    return wallet.writeContract(request);
  }

  // ---------------------------------------------------------------------------
  // Batch order management
  // ---------------------------------------------------------------------------

  /**
   * Place multiple limit orders on the same market in a single transaction.
   * Gas-optimized: aggregates token transfers (max 3 instead of N).
   * @param params.marketId - The market for all orders
   * @param params.orders   - Array of order params (max 20)
   */
  async batchPlaceOrders(params: {
    marketId: bigint;
    orders: Array<{
      outcomeId: bigint;
      side: number; // 0=BUY, 1=SELL
      tick: bigint;
      qty: bigint;
      expiry: bigint;
    }>;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: BatchOrdersFacetABI,
      functionName: 'batchPlaceOrders',
      args: [params.marketId, params.orders],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Place multiple limit orders with simple string inputs (recommended for frontends).
   * @param params.price    - Price as decimal string (e.g., "0.75")
   * @param params.quantity - Quantity as decimal string (e.g., "100.5")
   * @param params.expiry   - Duration string (e.g., "1h", "gtc") or bigint timestamp
   */
  async batchPlaceOrdersSimple(params: {
    marketId: bigint;
    orders: Array<{
      outcomeId: bigint;
      side: number;
      price: string;
      quantity: string;
      expiry: string | bigint;
    }>;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [params.marketId],
    });

    const collateralToken = tradingData.collateralToken as Address;
    const decimals = await getCachedTokenDecimals(this.publicClient, collateralToken);

    const orders = params.orders.map((o) => ({
      outcomeId: o.outcomeId,
      side: o.side,
      tick: priceToTick(o.price),
      qty: parseTokenAmount(o.quantity, decimals),
      expiry:
        typeof o.expiry === 'string'
          ? o.expiry === 'gtc'
            ? BigInt(0)
            : createExpiry(o.expiry)
          : o.expiry,
    }));

    return this.batchPlaceOrders({ marketId: params.marketId, orders });
  }

  /**
   * Cancel multiple orders atomically in a single transaction.
   * Orders can span different markets.
   * @param orderIds - Array of order IDs to cancel (max 100). Must be owned by caller.
   */
  async batchCancelOrders(orderIds: bigint[]) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: BatchOrdersFacetABI,
      functionName: 'batchCancelOrders',
      args: [orderIds],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Atomically cancel stale orders and place new ones on the same market.
   * Cancel phase runs first; if any step fails the entire tx reverts.
   * @param params.marketId       - Market for new orders
   * @param params.cancelOrderIds - Orders to cancel (max 100)
   * @param params.newOrders      - New orders to place (max 20)
   */
  async cancelAndReplace(params: {
    marketId: bigint;
    cancelOrderIds: bigint[];
    newOrders: Array<{
      outcomeId: bigint;
      side: number;
      tick: bigint;
      qty: bigint;
      expiry: bigint;
    }>;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: BatchOrdersFacetABI,
      functionName: 'cancelAndReplace',
      args: [params.marketId, params.cancelOrderIds, params.newOrders],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Cancel-and-replace with simple string inputs (recommended for frontends).
   */
  async cancelAndReplaceSimple(params: {
    marketId: bigint;
    cancelOrderIds: bigint[];
    newOrders: Array<{
      outcomeId: bigint;
      side: number;
      price: string;
      quantity: string;
      expiry: string | bigint;
    }>;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [params.marketId],
    });

    const collateralToken = tradingData.collateralToken as Address;
    const decimals = await getCachedTokenDecimals(this.publicClient, collateralToken);

    const newOrders = params.newOrders.map((o) => ({
      outcomeId: o.outcomeId,
      side: o.side,
      tick: priceToTick(o.price),
      qty: parseTokenAmount(o.quantity, decimals),
      expiry:
        typeof o.expiry === 'string'
          ? o.expiry === 'gtc'
            ? BigInt(0)
            : createExpiry(o.expiry)
          : o.expiry,
    }));

    return this.cancelAndReplace({
      marketId: params.marketId,
      cancelOrderIds: params.cancelOrderIds,
      newOrders,
    });
  }
}
