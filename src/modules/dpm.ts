import { BaseModule } from './base';
import {
  DpmMarketFacetABI,
  DpmTradingFacetABI,
  MarketsFacetABI,
  VenueFacetABI,
} from '../contracts';
import { erc20Abi, stringToHex } from 'viem';
import type { Address } from 'viem';
import { type MarketQuestion } from '../utils/conversions';
import { getCachedTokenDecimals, parseTokenAmount } from '../utils/decimals';

/**
 * DPM (Dynamic Pari-Mutuel) market overlay state — Pennock 2004 §4 ("DPM I").
 * Mirrors the on-chain `DpmMarket` struct returned by `getDpmMarket`.
 */
export interface DpmMarketData {
  /** Number of outcomes (2 for binary/price; N for categorical). */
  outcomeCount: bigint;
  /** Dynamic pricing begins; before it, enterIntent/exitIntent are 1:1 refundable. */
  openTime: bigint;
  /** Trading ends; resolution happens after this. */
  closeTime: bigint;
  /** Whether the intent→pool seed (M/N from intent totals) has been performed. */
  poolInitialized: boolean;
}

/** Live pool state for a single outcome (Pennock M_i / N_i). */
export interface DpmOutcomeState {
  outcome: number;
  /** Collateral backing this outcome (M_i), in collateral-token units. */
  collateral: bigint;
  /** Shares outstanding on this outcome (N_i). */
  shares: bigint;
}

/**
 * DPM markets: a self-funded trading mode parallel to the CLOB. Pick a side,
 * deposit collateral, price moves with flow — the operator never holds risk
 * (pure redistribution plus an outcome-independent entry fee). Two creation
 * shapes (binary/categorical UMA, binary Pyth) and a four-step trading
 * lifecycle: enterIntent (pre-open, refundable) → enter (dynamic) → claim.
 *
 * Write methods come in Raw (BigInt) and Simple (human-readable string)
 * variants, matching the rest of the SDK.
 */
export class DpmModule extends BaseModule {
  // =========================================================================
  // Creation
  // =========================================================================

  /**
   * Create a DPM market resolved by UMA. Binary (`["Yes","No"]`) or categorical
   * (N outcomes, 2..64). An optional intent (pre-game) phase runs while
   * `block.timestamp < openTime`, during which stakes are 1:1 refundable.
   *
   * The caller must have approved the Diamond for the creation fee **plus** the
   * UMA reward (venue default + `additionalReward`) in `collateralToken`.
   *
   * @param params.venueId          Existing, active venue.
   * @param params.outcomes         Outcome labels (length 2..64).
   * @param params.collateralToken  ERC20 collateral for the pool and UMA bond/reward.
   * @param params.question         Title + description (encoded into ancillary data).
   * @param params.openTime         Dynamic pricing start; `0` => immediate (no intent phase).
   * @param params.closeTime        Trading ends (strictly after the effective openTime).
   * @param params.additionalReward Extra UMA reward on top of the venue default (default 0).
   * @param params.liveness         UMA liveness seconds (default 0 => downstream min).
   * @param params.tags             Off-chain indexing tags.
   */
  async createMarket(params: {
    venueId: bigint;
    outcomes: string[];
    collateralToken: Address;
    question: MarketQuestion;
    openTime?: bigint;
    closeTime: bigint;
    additionalReward?: bigint;
    liveness?: bigint;
    tags?: string[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { ancillaryData, encodedTags } = await this._prepareCreation(
      params,
      await this.getSignerAddress(),
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'createDpmMarket',
      args: [
        params.venueId,
        ancillaryData,
        params.outcomes,
        params.collateralToken,
        params.additionalReward ?? BigInt(0),
        params.liveness ?? BigInt(0),
        params.openTime ?? BigInt(0),
        params.closeTime,
        encodedTags,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Create a binary DPM market resolved by a Pyth price feed (Up/Down or
   * explicit strike). Same pool mechanics as the UMA variant; only the
   * resolution source differs. Outcomes must be length 2 (e.g. `["Up","Down"]`).
   *
   * @param params.strikePrice      `0` => Up/Down (open captured at openTime); `>0` => explicit strike.
   * @param params.resolutionWindow Pyth timestamp tolerance in seconds (`0` => default 60s).
   */
  async createPriceMarket(params: {
    venueId: bigint;
    pythFeedId: `0x${string}`;
    strikePrice?: bigint;
    openTime?: bigint;
    closeTime: bigint;
    outcomes?: string[];
    collateralToken: Address;
    question: MarketQuestion;
    liveness?: bigint;
    tags?: string[];
    resolutionWindow?: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const outcomes = params.outcomes ?? ['Up', 'Down'];
    const { ancillaryData, encodedTags } = await this._prepareCreation(
      params,
      await this.getSignerAddress(),
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'createDpmPriceMarket',
      args: [
        params.venueId,
        params.pythFeedId,
        params.strikePrice ?? BigInt(0),
        params.openTime ?? BigInt(0),
        params.closeTime,
        outcomes,
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
   * Append a late outcome to a live categorical DPM market (e.g. a candidate who
   * enters after open). Venue-operator only, only while trading is live (before
   * closeTime). The new outcome starts empty (par-until-contested). Not
   * available on price (Pyth) markets, which are binary by nature.
   */
  async addOutcome(marketId: bigint, label: string) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'addDpmOutcome',
      args: [marketId, label],
      account,
    });

    return wallet.writeContract(request);
  }

  // =========================================================================
  // Trading
  // =========================================================================

  /** Deposit a 1:1 refundable intent stake before openTime (no fee, no pricing). */
  async enterIntent(params: { marketId: bigint; outcome: bigint; amount: bigint }) {
    return this._tradeWrite('enterIntent', [
      params.marketId,
      params.outcome,
      params.amount,
    ]);
  }

  async enterIntentSimple(params: { marketId: bigint; outcome: bigint; amount: string }) {
    const amount = await this._toRawAmount(params.marketId, params.amount);
    return this.enterIntent({ marketId: params.marketId, outcome: params.outcome, amount });
  }

  /** Withdraw a refundable intent stake before openTime (1:1). */
  async exitIntent(params: { marketId: bigint; outcome: bigint; amount: bigint }) {
    return this._tradeWrite('exitIntent', [
      params.marketId,
      params.outcome,
      params.amount,
    ]);
  }

  async exitIntentSimple(params: { marketId: bigint; outcome: bigint; amount: string }) {
    const amount = await this._toRawAmount(params.marketId, params.amount);
    return this.exitIntent({ marketId: params.marketId, outcome: params.outcome, amount });
  }

  /**
   * Enter the dynamic pool (openTime <= now < closeTime). Charges the entry fee
   * and buys shares at the Pennock price. Reverts on chain if fewer than
   * `minSharesOut` shares would be minted (slippage protection; pass `0` to opt out).
   */
  async enter(params: {
    marketId: bigint;
    outcome: bigint;
    amount: bigint;
    minSharesOut?: bigint;
  }) {
    return this._tradeWrite('enter', [
      params.marketId,
      params.outcome,
      params.amount,
      params.minSharesOut ?? BigInt(0),
    ]);
  }

  /**
   * Human-readable `enter`. Converts `amount` to raw collateral units and, unless
   * `maxSlippageBps` is `0`, derives `minSharesOut` from a live `quoteEntryShares`
   * quote minus the tolerance (default 100 bps = 1%).
   */
  async enterSimple(params: {
    marketId: bigint;
    outcome: bigint;
    amount: string;
    maxSlippageBps?: number;
  }) {
    const amount = await this._toRawAmount(params.marketId, params.amount);

    const slippageBps = params.maxSlippageBps ?? 100;
    let minSharesOut = BigInt(0);
    if (slippageBps > 0) {
      const quoted = await this.quoteEntryShares(params.marketId, params.outcome, amount);
      minSharesOut = (quoted * BigInt(10_000 - slippageBps)) / BigInt(10_000);
    }

    return this.enter({
      marketId: params.marketId,
      outcome: params.outcome,
      amount,
      minSharesOut,
    });
  }

  /**
   * Claim a resolved market's payout (DPM I: refund of price paid + losers'-pool
   * slice; full refund on invalid / no-contest). Claims across all of the
   * caller's outcomes in one call.
   */
  async claim(marketId: bigint) {
    return this._tradeWrite('claim', [marketId]);
  }

  // =========================================================================
  // Reads
  // =========================================================================

  /** Whether `marketId` trades via the DPM pool (vs the CLOB). */
  async isDpmMarket(marketId: bigint): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'isDpmMarket',
      args: [marketId],
    })) as boolean;
  }

  /** Read the DPM overlay state (outcome count + lifecycle + seed flag). */
  async get(marketId: bigint): Promise<DpmMarketData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getDpmMarket',
      args: [marketId],
    });
    return {
      outcomeCount: BigInt(r.outcomeCount),
      openTime: BigInt(r.openTime),
      closeTime: BigInt(r.closeTime),
      poolInitialized: r.poolInitialized as boolean,
    };
  }

  /** Live pool collateral M_i on `outcome`. */
  async getOutcomeCollateral(marketId: bigint, outcome: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getMarketCollateral',
      args: [marketId, outcome],
    })) as bigint;
  }

  /** Live shares outstanding N_i on `outcome`. */
  async getOutcomeShares(marketId: bigint, outcome: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getMarketShares',
      args: [marketId, outcome],
    })) as bigint;
  }

  /** A user's refundable intent stake on `outcome` (pre-seed). */
  async getIntentStake(marketId: bigint, user: Address, outcome: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getIntentStake',
      args: [marketId, user, outcome],
    })) as bigint;
  }

  /** A user's effective shares on `outcome`. */
  async getUserShares(marketId: bigint, user: Address, outcome: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getUserShares',
      args: [marketId, user, outcome],
    })) as bigint;
  }

  /** A user's net collateral basis on `outcome` (after fees). */
  async getUserPaid(marketId: bigint, user: Address, outcome: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'getUserPaid',
      args: [marketId, user, outcome],
    })) as bigint;
  }

  /**
   * Quote shares received for `amount` collateral on `outcome`, net of the entry
   * fee. Advisory — actual fills differ if pool state changes first. Use as the
   * basis for an `enter` slippage bound.
   */
  async quoteEntryShares(marketId: bigint, outcome: bigint, amount: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: DpmMarketFacetABI,
      functionName: 'quoteEntryShares',
      args: [marketId, outcome, amount],
    })) as bigint;
  }

  /**
   * Read live M_i / N_i for every outcome in one pass. Convenience for UIs that
   * render implied prices (e.g. `M_i / Σ M_j`).
   */
  async getPoolState(marketId: bigint): Promise<DpmOutcomeState[]> {
    const { outcomeCount } = await this.get(marketId);
    const n = Number(outcomeCount);
    const states: DpmOutcomeState[] = [];
    for (let i = 0; i < n; i++) {
      const outcome = BigInt(i);
      const [collateral, shares] = await Promise.all([
        this.getOutcomeCollateral(marketId, outcome),
        this.getOutcomeShares(marketId, outcome),
      ]);
      states.push({ outcome: i, collateral, shares });
    }
    return states;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async _tradeWrite(
    functionName: 'enterIntent' | 'exitIntent' | 'enter' | 'claim',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any[],
  ) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: DpmTradingFacetABI,
      functionName,
      args,
      account,
    });

    return wallet.writeContract(request);
  }

  /** Resolve a market's collateral decimals and parse a human-readable amount. */
  private async _toRawAmount(marketId: bigint, amount: string): Promise<bigint> {
    const decimals = await this._collateralDecimals(marketId);
    return parseTokenAmount(amount, decimals);
  }

  private async _collateralDecimals(marketId: bigint): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const td: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [marketId],
    });
    return getCachedTokenDecimals(this.publicClient, td.collateralToken as Address);
  }

  /** Creation-fee allowance pre-check + ancillary/tags encoding (mirrors priceMarket). */
  private async _prepareCreation(
    params: {
      venueId: bigint;
      collateralToken: Address;
      question: MarketQuestion;
      tags?: string[];
    },
    account: Address,
  ): Promise<{ ancillaryData: `0x${string}`; encodedTags: `0x${string}`[] }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const venue: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'getVenue',
      args: [params.venueId],
    });

    const feeRequired = venue.marketCreationFee as bigint;
    if (feeRequired > BigInt(0)) {
      const allowance = (await this.publicClient.readContract({
        address: params.collateralToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, this.config.diamondAddress],
      })) as bigint;

      if (allowance < feeRequired) {
        throw new Error(
          `Insufficient allowance for Market Creation Fee. Approved: ${allowance.toString()}, Required: ${feeRequired.toString()}. Note: UMA markets also need allowance for the reward.`,
        );
      }
    }

    const ancillaryData = this._formatAncillaryData(params.question);
    const encodedTags = (params.tags ?? []).map((t) => stringToHex(t, { size: 32 }));

    return { ancillaryData, encodedTags };
  }

  private _formatAncillaryData(question: MarketQuestion): `0x${string}` {
    let data = `q:title:${question.title}`;
    data += `,description:${question.description}`;
    return stringToHex(data);
  }
}
