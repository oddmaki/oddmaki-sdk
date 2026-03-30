import type {
  Address,
  PublicClient,
  WalletClient,
  Transport,
  Chain,
} from 'viem';

export interface OddMakiConfig {
  chain: Chain;
  transport: Transport;
  diamondAddress: Address;
  conditionalTokensAddress: Address;
  subgraphEndpoint: string;
}

export interface OddMakiClientConfig extends OddMakiConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}
