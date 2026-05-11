import { BaseModule } from './base';
import { ERC20ABI } from '../contracts';
import type { Address } from 'viem';

export class TokenModule extends BaseModule {
  /**
   * Approve a spender to spend tokens
   */
  async approve(token: Address, spender: Address, amount: bigint) {
    const wallet = this.walletClient;
    const account = await this.getSignerAccount();

    const { request } = await this.publicClient.simulateContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'approve',
      args: [spender, amount],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get allowance
   */
  async getAllowance(token: Address, owner: Address, spender: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
  }

  /**
   * Get balance
   */
  async getBalance(token: Address, owner: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
  }

  /**
   * Get token decimals
   */
  async getDecimals(token: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'decimals',
    });
  }

  /**
   * Get token symbol
   */
  async getSymbol(token: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'symbol',
    });
  }

  /**
   * Get token name
   */
  async getName(token: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20ABI,
      functionName: 'name',
    });
  }
}
