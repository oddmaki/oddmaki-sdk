import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicModule } from '../../src/modules/public';
import { OddMakiClientConfig } from '../../src/types';
import { baseSepolia } from 'viem/chains';
import { http } from 'viem';

// Mock GraphQLClient
const mockRequest = vi.fn();
vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    request: mockRequest,
  })),
  gql: (query: TemplateStringsArray) => query,
}));

describe('PublicModule', () => {
  let module: PublicModule;
  const config: OddMakiClientConfig = {
    chain: baseSepolia,
    transport: http(),
    diamondAddress: '0x0000000000000000000000000000000000000000',
    conditionalTokensAddress: '0x0000000000000000000000000000000000000000',
    subgraphEndpoint: 'https://example.com/subgraph',
    publicClient: {} as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    module = new PublicModule(config);
  });

  it('should fetch venues', async () => {
    const mockData = { venues: [{ id: '1', name: 'Test Venue' }] };
    mockRequest.mockResolvedValueOnce(mockData);

    const result = await module.getVenues();

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      first: 100,
      skip: 0,
      orderBy: 'createdAt',
      orderDirection: 'desc',
    });
    expect(result).toEqual(mockData);
  });

  it('should fetch markets', async () => {
    const mockData = { markets: [{ id: '1', question: 'Test Market' }] };
    mockRequest.mockResolvedValueOnce(mockData);

    const result = await module.getMarkets({ venueId: 1n });

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      venueId: '1',
      search: '',
      statuses: ['Draft', 'Active', 'Resolved', 'Invalid'],
      first: 100,
      skip: 0,
    });
    expect(result).toEqual(mockData);
  });

  it('should pass search filter to getMarkets', async () => {
    const mockData = { markets: [] };
    mockRequest.mockResolvedValueOnce(mockData);

    await module.getMarkets({ venueId: 1n, search: 'BTC' });

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      venueId: '1',
      search: 'BTC',
      statuses: ['Draft', 'Active', 'Resolved', 'Invalid'],
      first: 100,
      skip: 0,
    });
  });

  it('should pass statuses filter to getMarkets', async () => {
    const mockData = { markets: [] };
    mockRequest.mockResolvedValueOnce(mockData);

    await module.getMarkets({ venueId: 1n, statuses: ['Active'] });

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      venueId: '1',
      search: '',
      statuses: ['Active'],
      first: 100,
      skip: 0,
    });
  });

  it('should fetch a single market', async () => {
    const mockData = { markets: [{ id: '1', question: 'Test Market' }] };
    mockRequest.mockResolvedValueOnce(mockData);

    const result = await module.getMarket(1n);

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      marketId: '1',
    });
    expect(result).toEqual(mockData.markets[0]);
  });

  it('should return null if market not found', async () => {
    const mockData = { markets: [] };
    mockRequest.mockResolvedValueOnce(mockData);

    const result = await module.getMarket(999n);

    expect(result).toBeNull();
  });

  it('should fetch trade history', async () => {
    const mockData = { trades: [{ id: '1', amount: '100' }] };
    mockRequest.mockResolvedValueOnce(mockData);

    const result = await module.getTradeHistory({ marketId: 1n });

    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      marketId: '1',
      first: 100,
      skip: 0,
    });
    expect(result).toEqual(mockData);
  });
});
