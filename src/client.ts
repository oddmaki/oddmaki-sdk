import { createPublicClient, createWalletClient, http, custom } from 'viem';
import type { PublicClient, WalletClient, Account } from 'viem';
import type { OddMakiClientConfig } from './types';
import { CONTRACT_ADDRESSES, DEFAULT_CHAIN } from './config';
import { VenueModule } from './modules/venue';
import { MarketModule } from './modules/market';
import { TradeModule } from './modules/trade';
import { PublicModule } from './modules/public';
import { TokenModule } from './modules/token';
import { UmaModule } from './modules/uma';
import { AccessControlModule } from './modules/accessControl';
import { PriceMarketModule } from './modules/priceMarket';

export class OddMakiClient {
  public readonly config: OddMakiClientConfig;
  public readonly venue: VenueModule;
  public readonly market: MarketModule;
  public readonly trade: TradeModule;
  public readonly public: PublicModule;
  public readonly token: TokenModule;
  public readonly uma: UmaModule;
  public readonly accessControl: AccessControlModule;
  public readonly priceMarket: PriceMarketModule;

  constructor(config: OddMakiClientConfig) {
    this.config = config;
    this.venue = new VenueModule(config);
    this.market = new MarketModule(config);
    this.trade = new TradeModule(config);
    this.public = new PublicModule(config);
    this.token = new TokenModule(config);
    this.uma = new UmaModule(config);
    this.accessControl = new AccessControlModule(config);
    this.priceMarket = new PriceMarketModule(config);
  }
}

export function createOddMakiClient(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient?: any; // Optional: Pass directly from wagmi/viem (typed as any to avoid version mismatches)
  account?: Account;
  transport?: any; // Viem transport
  chain?: any; // Viem chain
  subgraphEndpoint?: string;
}): OddMakiClient {
  let chain = params.chain;
  let transport = params.transport;
  let account = params.account;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let walletClient = params.walletClient as WalletClient;

  // Overload: Use walletClient if provided
  if (walletClient) {
    chain = chain || walletClient.chain;
    // walletClient.transport is an object, but createPublicClient expects a function.
    // We wrap it in custom() to reuse the wallet's provider.
    transport = transport || custom(walletClient.transport);
    account = account || walletClient.account;
  }

  // Default defaults
  chain = chain || DEFAULT_CHAIN;
  transport = transport || http();

  const addresses =
    CONTRACT_ADDRESSES[chain.id as keyof typeof CONTRACT_ADDRESSES];

  if (!addresses) {
    throw new Error(`Unsupported chain ID: ${chain.id}`);
  }

  const publicClient = createPublicClient({
    chain,
    transport,
  }) as PublicClient;

  // If we didn't get a walletClient but have an account, create one
  if (!walletClient && account) {
    walletClient = createWalletClient({
      account,
      chain,
      transport,
    });
  }

  const config: OddMakiClientConfig = {
    chain,
    transport,
    diamondAddress: addresses.diamond,
    conditionalTokensAddress: addresses.conditionalTokens,
    subgraphEndpoint: params.subgraphEndpoint ?? addresses.subgraph,
    publicClient,
    walletClient,
  };

  return new OddMakiClient(config);
}
