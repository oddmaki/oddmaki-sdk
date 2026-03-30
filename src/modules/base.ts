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
}
