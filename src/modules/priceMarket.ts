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
    const windowSeconds = Number(pm.resolutionWindow);

    const closeVAA = await this.fetchPythHistoricalData(
      pm.feedId,
      Number(pm.closeTime),
      windowSeconds,
    );

    let pythUpdateData: `0x${string}`[];
    if (isDeferred) {
      const openVAA = await this.fetchPythHistoricalData(
        pm.feedId,
        Number(pm.openTime),
        windowSeconds,
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
   * Mark a stuck price market as Invalid and refund holders 50/50 via the CTF.
   * Permissionless: anyone can call this once `closeTime + 7 days` has elapsed.
   *
   * Use this for markets that never resolve via Pyth — e.g. the feed was
   * deprecated by the publisher, or Hermes had no in-window VAA at closeTime.
   * Reports payouts `[1, 1]` to the CTF, so every YES and every NO token
   * redeems for half the underlying collateral.
   *
   * Reverts on chain with `GracePeriodNotElapsed` if called too early.
   */
  async markInvalid(marketId: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: PythResolutionFacetABI,
      functionName: 'markPriceMarketInvalid',
      args: [marketId],
      account,
    });

    return wallet.writeContract(request);
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

    const parsed = await this.fetchPythHistoricalParsed(
      pm.feedId,
      Number(pm.openTime),
      Number(pm.resolutionWindow),
    );
    if (!parsed) return null;

    return {
      price: BigInt(parsed.price.price),
      publishTime: BigInt(parsed.price.publish_time),
      expo: Number(parsed.price.expo),
      canonical: now >= pm.openTime + pm.resolutionWindow,
      openTime: pm.openTime,
    };
  }

  /**
   * Fetch historical Pyth price update data covering the window
   * `[publishTime, publishTime + windowSeconds]`.
   *
   * Hermes serves a VAA AT the exact requested second when one exists, and
   * 404s when no publish landed in that second. For low-volume feeds or
   * markets resolving deep in the past this means a single request at
   * `publishTime` is fragile. This helper walks a few sample points across
   * the window until it finds a VAA, transparently retrying with exponential
   * backoff on 429.
   *
   * The on-chain `pickEarliestInWindow` accepts any VAA whose `publishTime`
   * falls in the same window, so returning an offset VAA is correct as long
   * as it's still in range.
   */
  private async fetchPythHistoricalData(
    feedId: `0x${string}`,
    publishTime: number,
    windowSeconds: number,
  ): Promise<`0x${string}`[]> {
    const result = await this.fetchPythHistoricalRaw(
      feedId,
      publishTime,
      windowSeconds,
    );
    if (!result) {
      throw new Error(
        `No Pyth VAA available in window [${publishTime}, ${publishTime + windowSeconds}] for feed ${feedId}`,
      );
    }
    return result.updateData;
  }

  /**
   * Hermes parsed+binary fetch shared by {@link fetchPythHistoricalData} and
   * {@link fetchProjectedOpenPrice}. Returns the first in-window VAA whose
   * Hermes response includes a `parsed[0].price` entry, walking a few sample
   * timestamps across the window before giving up. Returns `null` on
   * complete miss so the caller can decide how to surface the failure
   * (resolution throws; UI projection returns null gracefully).
   */
  private async fetchPythHistoricalParsed(
    feedId: `0x${string}`,
    publishTime: number,
    windowSeconds: number,
  ): Promise<{ price: { price: string; expo: number; publish_time: number } } | null> {
    const result = await this.fetchPythHistoricalRaw(
      feedId,
      publishTime,
      windowSeconds,
    );
    return result?.parsed ?? null;
  }

  private async fetchPythHistoricalRaw(
    feedId: `0x${string}`,
    publishTime: number,
    windowSeconds: number,
  ): Promise<{
    updateData: `0x${string}`[];
    parsed: { price: { price: string; expo: number; publish_time: number } };
  } | null> {
    // Sample at the start, a few points across the window, and the end.
    // 5 points balance coverage with Hermes rate-limit pressure: any feed
    // publishing every ~5s is virtually guaranteed to land in one of these.
    const window = Math.max(0, Math.floor(windowSeconds));
    const offsets = window === 0
      ? [0]
      : Array.from(new Set([
          0,
          Math.floor(window / 4),
          Math.floor(window / 2),
          Math.floor((3 * window) / 4),
          window,
        ])).sort((a, b) => a - b);

    for (const offset of offsets) {
      const t = publishTime + offset;
      const url = `${PYTH_HERMES_BASE}/v2/updates/price/${t}?ids[]=${feedId}`;

      const response = await this.hermesFetchWithBackoff(url);
      if (response === null) continue; // 404 / soft-miss at this timestamp

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();
      const updateDataRaw: string[] | undefined = data.binary?.data;
      const parsed = data.parsed?.[0];

      if (!updateDataRaw || updateDataRaw.length === 0) continue;

      return {
        updateData: updateDataRaw.map(
          (d) => `0x${d}` as `0x${string}`,
        ),
        parsed,
      };
    }

    return null;
  }

  /**
   * Fetch a Hermes URL with a short backoff on 429. Returns the response for
   * 2xx, `null` for 404 (treated as "no VAA at this timestamp, try another"),
   * and throws on persistent 429 or other non-OK statuses.
   *
   * Budget kept intentionally small (2 attempts) so callers that are already
   * iterating (e.g. multiple sample timestamps in `fetchPythHistoricalRaw`)
   * don't compound the rate-limit pressure. If Hermes is genuinely rate-
   * limiting us, retrying within the same request cycle won't help — better
   * to fail fast and let the caller back off until the next tick.
   */
  private async hermesFetchWithBackoff(
    url: string,
    options: { maxAttempts?: number; initialDelayMs?: number } = {},
  ): Promise<Response | null> {
    const maxAttempts = options.maxAttempts ?? 2;
    const initialDelayMs = options.initialDelayMs ?? 750;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(url);
      if (response.status === 429) {
        if (attempt === maxAttempts - 1) {
          throw new Error(
            `Pyth Hermes API error: 429 Too Many Requests (gave up after ${maxAttempts} attempts)`,
          );
        }
        const delay = initialDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `Pyth Hermes API error: ${response.status} ${response.statusText}`,
        );
      }
      return response;
    }
    return null;
  }
}
