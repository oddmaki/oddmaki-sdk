import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeModule } from '../../src/modules/trade';
import { OddMakiClientConfig } from '../../src/types';
import { baseSepolia } from 'viem/chains';
import { createPublicClient, createWalletClient, http } from 'viem';
import { LimitOrdersFacetABI, MarketOrdersFacetABI } from '../../src/contracts';

// Mock viem
const mockSimulateContract = vi.fn();
const mockGetAddresses = vi.fn();
const mockWriteContract = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    createPublicClient: vi.fn(() => ({
      simulateContract: mockSimulateContract,
    })),
    createWalletClient: vi.fn(() => ({
      getAddresses: mockGetAddresses,
      writeContract: mockWriteContract,
    })),
  };
});

describe('TradeModule', () => {
  let module: TradeModule;
  const config: OddMakiClientConfig = {
    chain: baseSepolia,
    transport: http(),
    diamondAddress: '0xDiamond',
    conditionalTokensAddress: '0x0000000000000000000000000000000000000000',
    subgraphEndpoint: 'https://example.com/subgraph',
    publicClient: createPublicClient({ chain: baseSepolia, transport: http() }) as any,
    walletClient: createWalletClient({ chain: baseSepolia, transport: http() }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    module = new TradeModule(config);
    mockGetAddresses.mockResolvedValue(['0xUser']);
    mockWriteContract.mockResolvedValue('0xtxhash');
  });

  it('should preview market BUY via the new multi-path facet selector', async () => {
    const mockResult = { tokensReceived: 100n, collateralSpent: 50n, avgPrice: 0n, unusedCollateral: 0n };
    mockSimulateContract.mockResolvedValue({ result: mockResult });

    const params = {
      marketId: 1n,
      outcomeId: 0n,
      budget: 100n,
      slippageBps: 500n,
      orderType: 1, // FAK
    };

    const result = await module.previewMarketBuy(params);

    expect(mockSimulateContract).toHaveBeenCalledWith({
      address: config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketBuy',
      args: [params.marketId, params.outcomeId, params.budget, params.slippageBps, params.orderType],
      account: '0xUser',
    });
    expect(result).toEqual(mockResult);
  });

  it('should preview market SELL via the new multi-path facet selector', async () => {
    const mockResult = { tokensSold: 100n, collateralReceived: 49n, avgPrice: 0n, unsoldTokens: 0n };
    mockSimulateContract.mockResolvedValue({ result: mockResult });

    const params = {
      marketId: 1n,
      outcomeId: 0n,
      tokenAmount: 100n,
      slippageBps: 500n,
      orderType: 1,
    };

    const result = await module.previewMarketSell(params);

    expect(mockSimulateContract).toHaveBeenCalledWith({
      address: config.diamondAddress,
      abi: MarketOrdersFacetABI,
      functionName: 'placeMarketSell',
      args: [params.marketId, params.outcomeId, params.tokenAmount, params.slippageBps, params.orderType],
      account: '0xUser',
    });
    expect(result).toEqual(mockResult);
  });

  it('should batch-cancel all orders on a resolved market via cancelOrdersOnResolvedMarket', async () => {
    const mockRequest = { foo: 'bar' };
    mockSimulateContract.mockResolvedValue({ request: mockRequest });

    const marketId = 42n;
    // More than 2 orders — matches the batch cancellation scenario.
    const orderIds = [1n, 2n, 3n, 4n];

    const txHash = await module.cancelOrdersOnResolvedMarket(marketId, orderIds);

    expect(mockSimulateContract).toHaveBeenCalledWith({
      address: config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'cancelOrdersOnResolvedMarket',
      args: [marketId, orderIds],
      account: '0xUser',
    });
    expect(mockWriteContract).toHaveBeenCalledWith(mockRequest);
    expect(txHash).toBe('0xtxhash');
  });

  it('should preview place order', async () => {
    const mockResult = { result: 'success' };
    mockSimulateContract.mockResolvedValue({ result: mockResult });

    const params = {
      marketId: 1n,
      outcomeId: 0n,
      side: 0,
      tick: 1000n,
      qty: 10n,
      expiry: 999999n,
    };

    const result = await module.previewPlaceOrder(params);

    expect(mockSimulateContract).toHaveBeenCalledWith({
      address: config.diamondAddress,
      abi: LimitOrdersFacetABI,
      functionName: 'placeOrder',
      args: [
        params.marketId,
        params.outcomeId,
        params.side,
        params.tick,
        params.qty,
        params.expiry,
      ],
      account: '0xUser',
    });
    expect(result).toEqual(mockResult);
  });
});
