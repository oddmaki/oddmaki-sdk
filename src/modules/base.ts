import type { Account, Address } from 'viem';
import type { OddMakiClientConfig } from '../types';
import { SubgraphClient } from '../subgraph/client';

export abstract class BaseModule {
  protected config: OddMakiClientConfig;
  protected subgraph: SubgraphClient;

  constructor(config: OddMakiClientConfig) {
    this.config = config;
    this.subgraph = new SubgraphClient(config.subgraphEndpoint);
  }

  protected get publicClient() {
    return this.config.publicClient;
  }

  protected get walletClient() {
    if (!this.config.walletClient) {
      throw new Error(
        'WalletClient not initialized. Write operations require a wallet.'
      );
    }
    return this.config.walletClient;
  }

  // Returns the hoisted LocalAccount when the wallet was created with a private
  // key, so viem signs locally (eth_sendRawTransaction). Falls back to the
  // address string for injected/JSON-RPC providers (wagmi, RainbowKit, etc).
  protected async getSignerAccount(): Promise<Account | Address> {
    const wallet = this.walletClient;
    if (wallet.account) return wallet.account;
    const [address] = await wallet.getAddresses();
    return address;
  }

  protected async getSignerAddress(): Promise<Address> {
    const signer = await this.getSignerAccount();
    return typeof signer === 'string' ? signer : signer.address;
  }
}
