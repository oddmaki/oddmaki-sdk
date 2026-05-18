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
  /**
   * Reference price for resolution.
   * - Explicit-strike markets: set at creation, never changes.
   * - Deferred Up/Down markets: 0 at creation, populated at resolution with the
   *   open price captured from the earliest Hermes VAA in
   *   `[openTime, openTime + resolutionWindow]`.
   */
  strikePrice: bigint;
  /**
   * Pyth VAA publishTime of the open-price capture (seconds since epoch).
   * - Explicit-strike markets: always 0 (no open price is captured).
   * - Deferred Up/Down markets: 0 until resolution, then set to the open VAA's
   *   publishTime.
   */
  openPriceTime: bigint;
}

/**
 * Latest Pyth price update plus the signed VAA's publishTime.
 * `fetchedAt` is the SDK-local unix timestamp (seconds) at fetch time.
 */
export interface PythUpdate {
  updateData: `0x${string}`[];
  publishTime: bigint;
  fetchedAt: bigint;
}

/**
 * Projected open price for a deferred Up/Down market that hasn't resolved yet.
 * Derived from the same Hermes VAA the on-chain resolver will pick.
 */
export interface ProjectedOpenPrice {
  /** Price extracted from the open-window Hermes VAA (Pyth feed-native units). */
  price: bigint;
  /** publishTime of the VAA (seconds since epoch). */
  publishTime: bigint;
  /** Pyth's price exponent for the feed (e.g. -8). Convenience for UI formatting. */
  expo: number;
  /**
   * `true` once `block.timestamp >= openTime + resolutionWindow` — past that point
   * every client querying Hermes the same way agrees on the same VAA and the
   * on-chain strike at resolution will equal this exact `price`. Before that,
   * the value is a best-effort projection that could shift slightly as Hermes
   * publishes new VAAs inside the window.
   */
  canonical: boolean;
  /** The market's openTime this projection corresponds to. */
  openTime: bigint;
}

/** Default cap for freshness helper retries. */
const DEFAULT_FRESH_MAX_AGE_SECONDS = 120;
const DEFAULT_FRESH_MAX_ATTEMPTS = 3;

export class PriceMarketModule extends BaseModule {
  /**
   * Create a Pyth-powered price market. Three shapes via one entry point:
   *
   * - **Immediate Up/Down** (`strikePrice = 0`, `openTime = 0` or omitted):
   *   `openTime` is set to `block.timestamp` at creation; open price is
   *   captured at resolution from the earliest Hermes VAA in
   *   `[openTime, openTime + resolutionWindow]`.
   *
   * - **Scheduled Up/Down** (`strikePrice = 0`, `openTime > now`):
   *   Market exists from creation and is tradable. At `openTime` the open
   *   price window begins; capture happens at resolution as above.
   *
   * - **Explicit strike** (`strikePrice > 0`): Above/Below market resolved
   *   against the caller-supplied target. `openTime` is ignored and stored
   *   as `block.timestamp`; no open-price capture occurs at resolution.
   *
   * Creation never touches Pyth — no VAA submission, no Pyth fee. The
   * resolver pays Pyth fees later when calling {@link resolvePyth}.
   *
   * @param params.venueId - The venue to create the market in
   * @param params.pythFeedId - Pyth price feed ID (e.g., ETH/USD)
   * @param params.strikePrice - Target price (0 = capture open at resolution)
   * @param params.openTime - When the market opens (0 = immediate / now)
   * @param params.closeTime - Absolute close timestamp (must be > effective openTime)
   * @param params.outcomes - Market outcome labels (e.g., ["Up", "Down"] or ["Above", "Below"])
   * @param params.tickSize - Price increment for the orderbook (1e15 or 1e16)
   * @param params.collateralToken - ERC20 collateral token address
   * @param params.question - Market question for ancillary data
   * @param params.liveness - UMA challenge period in seconds (0 = default)
   * @param params.tags - Optional tags for the market
   * @param params.resolutionWindow - Pyth timestamp tolerance in seconds (0 = default 60s, max 300s)
   */
  async createPyth(params: {
    venueId: bigint;
    pythFeedId: `0x${string}`;
    strikePrice?: bigint;
    openTime?: bigint;
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

    const { encodedTags, ancillaryData } =
      await this._prepareCreationCommon(params, await this.getSignerAddress());

    if (!isValidTickSize(params.tickSize)) {
      throw new Error('Invalid tickSize: must be 1e15 (0.1%) or 1e16 (1%)');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'createPriceMarketPyth',
      args: [
        params.venueId,
        params.pythFeedId,
        params.strikePrice ?? BigInt(0),
        params.openTime ?? BigInt(0),
        params.closeTime,
        outcomes,
        params.tickSize,
        params.collateralToken,
        ancillaryData,
        params.liveness ?? BigInt(0),
        encodedTags,
        params.resolutionWindow ?? BigInt(0),
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Resolve a price market using Pyth.
   *
   * Anyone can call this after `closeTime`. For deferred Up/Down markets
   * (`strikePrice == 0`), the SDK fetches **two** Hermes VAAs — one for the
   * open window, one for the close window — and submits them together so the
   * on-chain facet can capture the open price and compare against the close
   * in a single transaction. For explicit-strike markets only the close VAA
   * is fetched.
   */
  async resolvePyth(marketId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

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

    const isDeferred = pm.strikePrice === BigInt(0);

    const closeVAA = await this.fetchPythHistoricalData(
      pm.feedId,
      Number(pm.closeTime),
    );

    let pythUpdateData: `0x${string}`[];
    if (isDeferred) {
      const openVAA = await this.fetchPythHistoricalData(
        pm.feedId,
        Number(pm.openTime),
      );
      pythUpdateData = [...openVAA, ...closeVAA];
    } else {
      pythUpdateData = closeVAA;
    }

    const pythAddress = await this.getPythContract();
    const pythFee = (await this.publicClient.readContract({
      address: pythAddress,
      abi: PYTH_GET_UPDATE_FEE_ABI,
      functionName: 'getUpdateFee',
      args: [pythUpdateData],
    })) as bigint;

    // Use at least 1 gwei to cover edge cases where getUpdateFee returns 0 via
    // eth_call but the actual tx requires non-zero value. Contract refunds excess.
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
   * Check if a price market can be resolved (closeTime reached and not yet resolved).
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

    const ancillaryData = this.formatAncillaryData(params.question);

    const encodedTags = (params.tags ?? []).map((t) =>
      stringToHex(t, { size: 32 }),
    );

    return { encodedTags, ancillaryData };
  }

  private formatAncillaryData(question: MarketQuestion): `0x${string}` {
    let data = `q:title:${question.title}`;
    data += `,description:${question.description}`;
    return stringToHex(data);
  }

  /**
   * Fetch the latest Pyth price update from Hermes — the bytes plus the
   * VAA's publishTime.
   *
   * Useful for UI projected-strike display: callers can render the current
   * Pyth price (and its publishTime) before a deferred market's open window
   * closes, then switch to the on-chain strike once resolution happens.
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
   * Return a Pyth update that is fresh enough for client-side projected-strike
   * display.
   *
   * If `cached` is provided and still within `maxAgeSeconds`, returns it
   * unchanged. Otherwise re-queries Hermes; if the new VAA is also stale
   * (quiet feed), retries up to `maxAttempts`.
   *
   * Defaults: `maxAgeSeconds = 120`, `maxAttempts = 3`.
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
   * Resolve the projected open price for a deferred Up/Down market — what the
   * UI should display as the "strike" between `openTime` and resolution.
   *
   * For deferred markets, the on-chain `strikePrice` is 0 until the resolver
   * fires {@link resolvePyth}. This helper replicates the same rule the
   * contract will use ("earliest in-window Hermes VAA in
   * `[openTime, openTime + resolutionWindow]`") by querying Hermes at
   * `openTime`, so the value rendered in the UI matches what the on-chain
   * strike will be once resolution lands.
   *
   * Returns `null` when the projection isn't applicable:
   * - The market is already resolved — caller should read `pm.strikePrice` directly.
   * - The market is explicit-strike (`pm.strikePrice > 0`) — same, read from chain.
   * - The market hasn't reached `openTime` yet — no VAA exists; UI should show
   *   "strike set at HH:MM" or similar pending state.
   *
   * `result.canonical === true` means the open window has fully elapsed and the
   * value will not change. Before that, render the price with a "pending" hint.
   */
  async fetchProjectedOpenPrice(
    marketId: bigint,
  ): Promise<ProjectedOpenPrice | null> {
    const pm = await this.get(marketId);

    if (pm.resolved) return null;
    if (pm.strikePrice !== BigInt(0)) return null;

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < pm.openTime) return null;

    const url = `${PYTH_HERMES_BASE}/v2/updates/price/${pm.openTime}?ids[]=${pm.feedId}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Pyth Hermes API error: ${response.status} ${response.statusText}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    const parsed = data.parsed?.[0];
    if (!parsed?.price) {
      throw new Error('Pyth Hermes response missing parsed.price for open VAA');
    }

    return {
      price: BigInt(parsed.price.price),
      publishTime: BigInt(parsed.price.publish_time),
      expo: Number(parsed.price.expo),
      canonical: now >= pm.openTime + pm.resolutionWindow,
      openTime: pm.openTime,
    };
  }

  /**
   * Fetch historical Pyth price update data at a specific timestamp.
   * Used internally by {@link resolvePyth} to fetch open-window and
   * close-window VAAs.
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
