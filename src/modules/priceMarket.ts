import { BaseModule } from './base';
import {
  PriceMarketFacetABI,
  PythResolutionFacetABI,
  VenueFacetABI,
} from '../contracts';
import { erc20Abi, stringToHex } from 'viem';
import type { Address } from 'viem';
import { isValidTickSize, type MarketQuestion } from '../utils/conversions';

const PYTH_HERMES_BASE = 'https://hermes.pyth.network';

const PYTH_GET_UPDATE_FEE_ABI = [
  {
    name: 'getUpdateFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ name: 'feeAmount', type: 'uint256' }],
  },
] as const;

export enum FeedProvider {
  PYTH = 0,
  CHAINLINK = 1,
}

export interface PriceMarketData {
  feedId: `0x${string}`;
  feedProvider: FeedProvider;
  openTime: bigint;
  closeTime: bigint;
  priceExpo: number;
  finalPrice: bigint;
  resolutionWindow: bigint;
  resolved: boolean;
  strikePrice: bigint;
  /**
   * Pyth VAA publishTime for the opening-price capture (seconds since epoch).
   * 0 for strike markets (no opening price is captured).
   */
  openPriceTime: bigint;
}

/**
 * Latest Pyth price update data plus the signed VAA's publishTime.
 * `fetchedAt` is the SDK-local unix timestamp (seconds) at fetch time.
 */
export interface PythUpdate {
  updateData: `0x${string}`[];
  publishTime: bigint;
  fetchedAt: bigint;
}

/** Default cap for freshness helper retries. */
const DEFAULT_FRESH_MAX_AGE_SECONDS = 120;
const DEFAULT_FRESH_MAX_ATTEMPTS = 3;

export class PriceMarketModule extends BaseModule {
  /**
   * Create a Pyth-powered price market
   *
   * When strikePrice > 0, creates a strike market resolved against
   * the explicit target price. No Pyth update data or ETH is needed.
   * When strikePrice is 0 or omitted, captures the current Pyth price
   * and uses it as the reference (standard Up/Down market).
   *
   * @param params.venueId - The venue to create the market in
   * @param params.pythFeedId - Pyth price feed ID (e.g., ETH/USD)
   * @param params.strikePrice - Target price in feed's exponent scale (0 = use current price)
   * @param params.closeTime - Absolute close timestamp (must be 300–86400s from now)
   * @param params.outcomes - Market outcome labels (e.g., ["Up", "Down"] or ["Above", "Below"])
   * @param params.tickSize - Price increment for the orderbook
   * @param params.collateralToken - ERC20 collateral token address
   * @param params.question - Market question for UMA ancillary data (fallback)
   * @param params.liveness - UMA challenge period in seconds (0 = default)
   * @param params.tags - Optional tags for the market
   * @param params.resolutionWindow - Pyth timestamp tolerance in seconds (0 = default 60s)
   */
  async createPyth(params: {
    venueId: bigint;
    pythFeedId: `0x${string}`;
    strikePrice?: bigint;
    closeTime: bigint;
    outcomes?: string[];
    tickSize: bigint;
    collateralToken: Address;
    question: MarketQuestion;
    liveness?: bigint;
    tags?: string[];
    resolutionWindow?: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const outcomes = params.outcomes ?? ['Up', 'Down'];
    const isStrikeMarket = params.strikePrice && params.strikePrice > BigInt(0);

    // Pre-flight: check creation fee allowance + prepare common data
    const { encodedTags, ancillaryData } =
      await this._prepareCreationCommon(params, await this.getSignerAddress());

    if (!isValidTickSize(params.tickSize)) {
      throw new Error('Invalid tickSize: must be 1e15 (0.1%) or 1e16 (1%)');
    }

    // Strike markets: no Pyth update needed, no ETH required
    // Up/Down markets: fetch Pyth data and pay update fee
    let pythUpdateData: `0x${string}`[] = [];
    let valueSent = BigInt(0);

    if (!isStrikeMarket) {
      const pythResult = await this._preparePythUpdate(params.pythFeedId);
      pythUpdateData = pythResult.pythUpdateData;
      valueSent = pythResult.valueSent;
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'createPriceMarketPyth',
      args: [
        params.venueId,
        params.pythFeedId,
        params.strikePrice ?? BigInt(0),
        params.closeTime,
        outcomes,
        params.tickSize,
        params.collateralToken,
        ancillaryData,
        params.liveness ?? BigInt(0),
        encodedTags,
        params.resolutionWindow ?? BigInt(0),
        pythUpdateData,
      ],
      account,
      value: valueSent,
    });

    return wallet.writeContract(request);
  }

  /**
   * Resolve a price market using Pyth closing price
   *
   * Anyone can call this after the market's closeTime has passed.
   * Fetches the historical Pyth price at closeTime and submits it.
   * Works for both standard price markets and strike markets.
   */
  async resolvePyth(marketId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    // Get price market data to determine closeTime and feedId
    const pm = await this.get(marketId);

    if (pm.resolved) {
      throw new Error('Price market already resolved');
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < pm.closeTime) {
      throw new Error(
        `Close time not reached. Current: ${now.toString()}, CloseTime: ${pm.closeTime.toString()}`,
      );
    }

    // Fetch historical Pyth price data at closeTime
    const pythUpdateData = await this.fetchPythHistoricalData(
      pm.feedId,
      Number(pm.closeTime),
    );

    // Query the Pyth contract for the required update fee
    const pythAddress = await this.getPythContract();
    const pythFee = (await this.publicClient.readContract({
      address: pythAddress,
      abi: PYTH_GET_UPDATE_FEE_ABI,
      functionName: 'getUpdateFee',
      args: [pythUpdateData],
    })) as bigint;

    const valueSent = pythFee > BigInt(0) ? pythFee : BigInt(1_000_000_000);

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'resolvePriceMarketPyth',
      args: [marketId, pythUpdateData],
      account,
      value: valueSent,
    });

    return wallet.writeContract(request);
  }

  /**
   * Check if a market is a Pyth price market
   */
  async isPriceMarket(marketId: bigint): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: PriceMarketFacetABI,
      functionName: 'isPriceMarket',
      args: [marketId],
    })) as boolean;
  }

  /**
   * Check if a price market can be resolved
   */
  async canResolve(marketId: bigint): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: PriceMarketFacetABI,
      functionName: 'canResolvePriceMarket',
      args: [marketId],
    })) as boolean;
  }

  /**
   * Get price market data
   */
  async get(marketId: bigint): Promise<PriceMarketData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: PriceMarketFacetABI,
      functionName: 'getPriceMarket',
      args: [marketId],
    });

    return {
      feedId: result[0] as `0x${string}`,
      feedProvider: Number(result[1]) as FeedProvider,
      openTime: BigInt(result[2]),
      closeTime: BigInt(result[3]),
      priceExpo: Number(result[4]),
      finalPrice: BigInt(result[5]),
      resolutionWindow: BigInt(result[6]),
      resolved: result[7] as boolean,
      strikePrice: BigInt(result[8]),
      openPriceTime: BigInt(result[9]),
    };
  }

  /**
   * Get the Pyth contract address configured on the Diamond
   */
  async getPythContract(): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'getPythContract',
    })) as Address;
  }

  /**
   * Set the Pyth oracle contract address. Diamond owner only.
   */
  async setPythContract(pythContract: Address) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'setPythContract',
      args: [pythContract],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get the effective opening-price staleness window in seconds.
   *
   * A submitted VAA's `publishTime` must fall within
   * `[block.timestamp - openMaxStaleness, block.timestamp + OPEN_FUTURE_SKEW]`
   * at `createPriceMarketPyth` time. Defaults to 300s when unset on-chain.
   */
  async getOpenMaxStaleness(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'getOpenMaxStaleness',
    })) as bigint;
  }

  /**
   * Set the opening-price staleness window (seconds). Diamond owner only.
   * Pass 0 to fall back to the built-in default.
   */
  async setOpenMaxStaleness(openMaxStaleness: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'setOpenMaxStaleness',
      args: [openMaxStaleness],
      account,
    });

    return wallet.writeContract(request);
  }

  // ---- Private helpers ----

  /**
   * Shared pre-flight checks: creation fee allowance, ancillary data, tags
   */
  private async _prepareCreationCommon(
    params: {
      venueId: bigint;
      collateralToken: Address;
      question: MarketQuestion;
      tags?: string[];
    },
    account: Address,
  ) {
    // Check creation fee allowance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const venue: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'getVenue',
      args: [params.venueId],
    });

    const feeRequired = venue.marketCreationFee;
    if (feeRequired > BigInt(0)) {
      const allowance = await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, this.config.diamondAddress],
      });

      if (allowance < feeRequired) {
        throw new Error(
          `Insufficient allowance for Market Creation Fee. Approved: ${allowance.toString()}, Required: ${feeRequired.toString()}.`,
        );
      }
    }

    // Format ancillary data
    const ancillaryData = this.formatAncillaryData(params.question);

    // Encode tags
    const encodedTags = (params.tags ?? []).map((t) =>
      stringToHex(t, { size: 32 }),
    );

    return { encodedTags, ancillaryData };
  }

  /**
   * Fetch Pyth update data and compute the required ETH value (for Up/Down markets)
   */
  private async _preparePythUpdate(feedId: `0x${string}`) {
    const pythUpdateData = await this.fetchPythUpdateData(feedId);

    const pythAddress = await this.getPythContract();
    const pythFee = (await this.publicClient.readContract({
      address: pythAddress,
      abi: PYTH_GET_UPDATE_FEE_ABI,
      functionName: 'getUpdateFee',
      args: [pythUpdateData],
    })) as bigint;

    // Use at least 1 gwei to avoid edge cases where getUpdateFee returns 0
    // via eth_call but the actual tx requires more. Contract refunds excess.
    const valueSent = pythFee > BigInt(0) ? pythFee : BigInt(1_000_000_000);

    return { pythUpdateData, valueSent };
  }

  private formatAncillaryData(question: MarketQuestion): `0x${string}` {
    let data = `q:title:${question.title}`;
    data += `,description:${question.description}`;
    return stringToHex(data);
  }

  /**
   * Fetch latest Pyth price update from Hermes — bytes plus the VAA's publishTime.
   *
   * Use this (or {@link fetchFreshPythUpdate}) instead of re-rolling Hermes
   * calls when building `createPriceMarketPyth` transactions. The on-chain
   * staleness window defaults to 300s — if the user takes longer than that
   * to sign, the VAA will be rejected.
   */
  async fetchPythLatestUpdate(feedId: `0x${string}`): Promise<PythUpdate> {
    const url = `${PYTH_HERMES_BASE}/v2/updates/price/latest?ids[]=${feedId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Pyth Hermes API error: ${response.status} ${response.statusText}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    const updateData: string[] | undefined = data.binary?.data;

    if (!updateData || updateData.length === 0) {
      throw new Error('No price update data returned from Pyth Hermes');
    }

    const parsed = data.parsed?.[0];
    const publishTimeRaw = parsed?.price?.publish_time;
    if (typeof publishTimeRaw !== 'number') {
      throw new Error('Pyth Hermes response missing parsed.price.publish_time');
    }

    return {
      updateData: updateData.map((d) => `0x${d}` as `0x${string}`),
      publishTime: BigInt(publishTimeRaw),
      fetchedAt: BigInt(Math.floor(Date.now() / 1000)),
    };
  }

  /**
   * Return a Pyth update that is fresh enough to pass the on-chain staleness check.
   *
   * If `cached` is provided and still within `maxAgeSeconds`, it is returned as-is.
   * Otherwise Hermes is re-queried; if the newly fetched VAA is also older than
   * `maxAgeSeconds` (e.g. feed is quiet), it retries up to `maxAttempts`.
   *
   * Defaults: `maxAgeSeconds = 120` (leaves ~180s headroom under the 300s default
   * on-chain window), `maxAttempts = 3`.
   */
  async fetchFreshPythUpdate(
    feedId: `0x${string}`,
    options: {
      maxAgeSeconds?: number;
      maxAttempts?: number;
      cached?: PythUpdate;
    } = {},
  ): Promise<PythUpdate> {
    const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_FRESH_MAX_AGE_SECONDS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_FRESH_MAX_ATTEMPTS;

    const isFresh = (u: PythUpdate): boolean => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      return now - u.publishTime <= BigInt(maxAgeSeconds);
    };

    if (options.cached && isFresh(options.cached)) {
      return options.cached;
    }

    let latest: PythUpdate | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      latest = await this.fetchPythLatestUpdate(feedId);
      if (isFresh(latest)) return latest;
    }

    if (!latest) {
      throw new Error('Failed to fetch any Pyth update from Hermes');
    }
    return latest;
  }

  /**
   * Fetch latest Pyth price update data from Hermes API (raw bytes only).
   */
  private async fetchPythUpdateData(
    feedId: `0x${string}`,
  ): Promise<`0x${string}`[]> {
    const { updateData } = await this.fetchPythLatestUpdate(feedId);
    return updateData;
  }

  /**
   * Fetch historical Pyth price update data at a specific timestamp
   */
  private async fetchPythHistoricalData(
    feedId: `0x${string}`,
    publishTime: number,
  ): Promise<`0x${string}`[]> {
    const url = `${PYTH_HERMES_BASE}/v2/updates/price/${publishTime}?ids[]=${feedId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Pyth Hermes API error: ${response.status} ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    const updateData = data.binary?.data;

    if (!updateData || updateData.length === 0) {
      throw new Error('No historical price data returned from Pyth Hermes');
    }

    return updateData.map((d: string) => `0x${d}` as `0x${string}`);
  }
}
