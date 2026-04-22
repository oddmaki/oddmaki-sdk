import { BaseModule } from './base';
import { AccessControlFacetABI, WhitelistAccessControlABI } from '../contracts';

export class AccessControlModule extends BaseModule {
  // ---- Factory (deploy standalone AC contracts via Diamond) ----

  /**
   * Deploy a WhitelistAccessControl contract. Caller becomes the owner.
   * @returns Transaction hash. Use receipt logs to extract the deployed contract address.
   */
  async deployWhitelist() {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'deployWhitelistAC',
      args: [],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Deploy an NFTGatedAccessControl contract.
   * @param params.nftContract - The NFT contract address (ERC-721 or ERC-1155).
   * @param params.isERC1155 - True if the NFT contract is ERC-1155, false for ERC-721.
   * @param params.tokenId - The token ID to check (only used for ERC-1155, pass 0n for ERC-721).
   */
  async deployNFTGated(params: {
    nftContract: `0x${string}`;
    isERC1155: boolean;
    tokenId: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'deployNFTGatedAC',
      args: [params.nftContract, params.isERC1155, params.tokenId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Deploy a TokenGatedAccessControl contract.
   * @param params.token - The ERC-20 token contract address.
   * @param params.minBalance - The minimum token balance required for access.
   */
  async deployTokenGated(params: {
    token: `0x${string}`;
    minBalance: bigint;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'deployTokenGatedAC',
      args: [params.token, params.minBalance],
      account,
    });

    return wallet.writeContract(request);
  }

  // ---- Configuration (market-level AC overrides) ----

  /**
   * Set a trading access control contract for a specific market. Venue operator only.
   */
  async setMarketTradingAC(params: {
    marketId: bigint;
    acContract: `0x${string}`;
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'setMarketTradingAccessControl',
      args: [params.marketId, params.acContract],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Remove the trading access control override for a specific market. Venue operator only.
   */
  async removeMarketTradingAC(params: { marketId: bigint }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'removeMarketTradingAccessControl',
      args: [params.marketId],
      account,
    });

    return wallet.writeContract(request);
  }

  // ---- Queries (read via Diamond) ----

  /**
   * Check if a user can trade on a specific market (checks market-level then venue-level fallback).
   */
  async canTradeOnMarket(params: {
    user: `0x${string}`;
    marketId: bigint;
  }): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'canTradeOnMarket',
      args: [params.user, params.marketId],
    }) as Promise<boolean>;
  }

  /**
   * Get the market-level trading AC contract address (address(0) if not set).
   */
  async getMarketTradingAC(params: {
    marketId: bigint;
  }): Promise<`0x${string}`> {
    return this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: AccessControlFacetABI,
      functionName: 'getMarketTradingAccessControl',
      args: [params.marketId],
    }) as Promise<`0x${string}`>;
  }

  // ---- Whitelist management (direct contract calls, not through Diamond) ----

  /**
   * Add users to a WhitelistAccessControl contract. Only the contract owner can call this.
   */
  async addToWhitelist(params: {
    acContract: `0x${string}`;
    users: `0x${string}`[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: params.acContract,
      abi: WhitelistAccessControlABI,
      functionName: 'addToWhitelist',
      args: [params.users],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Remove users from a WhitelistAccessControl contract. Only the contract owner can call this.
   */
  async removeFromWhitelist(params: {
    acContract: `0x${string}`;
    users: `0x${string}`[];
  }) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: params.acContract,
      abi: WhitelistAccessControlABI,
      functionName: 'removeFromWhitelist',
      args: [params.users],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Check if a user is whitelisted on a specific WhitelistAccessControl contract.
   */
  async isWhitelisted(params: {
    acContract: `0x${string}`;
    user: `0x${string}`;
  }): Promise<boolean> {
    return this.publicClient.readContract({
      address: params.acContract,
      abi: WhitelistAccessControlABI,
      functionName: 'isAllowed',
      args: [params.user],
    }) as Promise<boolean>;
  }
}
