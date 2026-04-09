import { BaseModule } from './base';
import { VenueFacetABI, ProtocolFacetABI } from '../contracts';

export class VenueModule extends BaseModule {
  /**
   * Create a new venue
   *
   * IMPORTANT: Fee and bond amounts must match your intended collateral token decimals!
   * Most venues use USDC (6 decimals), so amounts should use parseUnits("amount", 6).
   *
   * Example for USDC-based venue:
   * - marketCreationFee: parseUnits("10", 6)  // 10 USDC
   * - umaRewardAmount: parseUnits("5", 6)     // 5 USDC
   * - umaMinBond: parseUnits("1", 6)          // 1 USDC
   * - defaultTickSize: parseEther("0.01")     // 0.01 per tick (always 18 decimals)
   *
   * @param params.marketCreationFee - Upfront fee (min 5e6 for USDC, split 50/50 protocol/venue)
   * @param params.umaRewardAmount - Default reward for UMA asserters (in collateral token units)
   * @param params.umaMinBond - Minimum bond for UMA assertions (in collateral token units)
   * @param params.defaultTickSize - Price increment per tick (always 1e18 scale, e.g., 0.01e18)
   */
  async createVenue(params: {
    name: string;
    metadata: string;
    tradingAccessControl: `0x${string}`;
    creationAccessControl: `0x${string}`;
    feeRecipient: `0x${string}`;
    venueFeeBps: number;
    creatorFeeBps: number;
    defaultTickSize: bigint;
    marketCreationFee: bigint;
    umaRewardAmount: bigint;
    umaMinBond: bigint;
  }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'createVenue',
      args: [
        params.name,
        params.metadata,
        params.tradingAccessControl,
        params.creationAccessControl,
        params.feeRecipient,
        params.venueFeeBps,
        params.creatorFeeBps,
        params.defaultTickSize,
        params.marketCreationFee,
        params.umaRewardAmount,
        params.umaMinBond,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Update venue fees
   */
  async updateFees(params: {
    venueId: bigint;
    venueFeeBps: number;
    creatorFeeBps: number;
  }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'updateVenueFees',
      args: [params.venueId, params.venueFeeBps, params.creatorFeeBps],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Pause venue
   */
  async setPaused(venueId: bigint, paused: boolean) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const functionName = paused ? 'pauseVenue' : 'unpauseVenue';

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName,
      args: [venueId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get venue data from on-chain storage
   */
  async getVenue(venueId: bigint) {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'getVenue',
      args: [venueId],
    });
  }

  /**
   * Update venue settings (name, metadata, access control, fee recipient)
   */
  async updateVenue(params: {
    venueId: bigint;
    name: string;
    metadata: string;
    tradingAccessControl: `0x${string}`;
    creationAccessControl: `0x${string}`;
    feeRecipient: `0x${string}`;
  }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'updateVenue',
      args: [
        params.venueId,
        params.name,
        params.metadata,
        params.tradingAccessControl,
        params.creationAccessControl,
        params.feeRecipient,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Update venue oracle parameters (UMA reward and min bond)
   */
  async updateOracleParams(params: {
    venueId: bigint;
    umaRewardAmount: bigint;
    umaMinBond: bigint;
  }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'updateVenueOracleParams',
      args: [params.venueId, params.umaRewardAmount, params.umaMinBond],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Check if a user can trade on a venue (venue-level AC only, no market override).
   */
  async canTrade(user: `0x${string}`, venueId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'canTrade',
      args: [user, venueId],
    }) as Promise<boolean>;
  }

  /**
   * Check if a user can create markets on a venue.
   */
  async canCreateMarket(user: `0x${string}`, venueId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: VenueFacetABI,
      functionName: 'canCreateMarket',
      args: [user, venueId],
    }) as Promise<boolean>;
  }

  // ---- Protocol Fee (owner-only) ----

  /**
   * Get the current protocol fee in basis points. Snapshotted per market at creation.
   */
  async getProtocolFeeBps(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: ProtocolFacetABI,
      functionName: 'getProtocolFeeBps',
    }) as Promise<bigint>;
  }

  /**
   * Set the protocol fee in basis points. Owner-only. Max 200 bps (2%).
   * Only affects markets created after this call (existing markets retain their snapshot).
   */
  async setProtocolFeeBps(bps: bigint) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: ProtocolFacetABI,
      functionName: 'setProtocolFeeBps',
      args: [bps],
      account,
    });

    return wallet.writeContract(request);
  }
}
