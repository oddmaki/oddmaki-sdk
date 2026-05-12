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

  describe('raw', () => {
    it('passes query and variables straight through to subgraph', async () => {
      const mockData = { foo: 'bar' };
      mockRequest.mockResolvedValueOnce(mockData);

      const query = 'query Foo($x: Int!) { foo(x: $x) }';
      const result = await module.raw(query, { x: 42 });

      expect(mockRequest).toHaveBeenCalledWith(query, { x: 42 });
      expect(result).toEqual(mockData);
    });

    it('works without variables', async () => {
      mockRequest.mockResolvedValueOnce({ ok: true });
      await module.raw('query { ok }');
      expect(mockRequest).toHaveBeenCalledWith('query { ok }', undefined);
    });
  });

  describe('findPriceMarketByFeedAndCloseTime', () => {
    const params = {
      pythFeedId:
        '0xE62DF6C8B4A85FE1A67DB44DC12DE5DB330F7AC66B72DC658AFEDF0F4A415B43' as `0x${string}`,
      closeTime: 1_800_000_000n,
      creator: '0xABcd000000000000000000000000000000000001' as `0x${string}`,
    };

    it('lowercases address args and stringifies bigints', async () => {
      mockRequest.mockResolvedValueOnce({ priceMarkets: [] });

      await module.findPriceMarketByFeedAndCloseTime(params);

      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        feedId: params.pythFeedId.toLowerCase(),
        closeTime: '1800000000',
        creator: params.creator.toLowerCase(),
      });
    });

    it('returns marketId as bigint on hit', async () => {
      mockRequest.mockResolvedValueOnce({
        priceMarkets: [{ id: 'pm-1', market: { marketId: '7' } }],
      });

      const result = await module.findPriceMarketByFeedAndCloseTime(params);

      expect(result).toEqual({ marketId: 7n });
    });

    it('returns null when no match', async () => {
      mockRequest.mockResolvedValueOnce({ priceMarkets: [] });

      const result = await module.findPriceMarketByFeedAndCloseTime(params);

      expect(result).toBeNull();
    });
  });

  describe('findExpiredOpenPriceMarkets', () => {
    const creator =
      '0xABcd000000000000000000000000000000000001' as `0x${string}`;

    it('passes creator (lowercased), now, and default first=100', async () => {
      mockRequest.mockResolvedValueOnce({ priceMarkets: [] });

      await module.findExpiredOpenPriceMarkets({
        creator,
        now: 1_800_000_000n,
      });

      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        creator: creator.toLowerCase(),
        now: '1800000000',
        first: 100,
      });
    });

    it('respects custom first', async () => {
      mockRequest.mockResolvedValueOnce({ priceMarkets: [] });

      await module.findExpiredOpenPriceMarkets({
        creator,
        now: 1_800_000_000n,
        first: 25,
      });

      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        creator: creator.toLowerCase(),
        now: '1800000000',
        first: 25,
      });
    });

    it('coerces string fields back to bigint/hex', async () => {
      mockRequest.mockResolvedValueOnce({
        priceMarkets: [
          {
            id: 'pm-1',
            feedId:
              '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            closeTime: '1799999000',
            market: { marketId: '1' },
          },
          {
            id: 'pm-2',
            feedId:
              '0xff5cc3d1bcd0c9c0e0eaccd5b67ea4f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
            closeTime: '1799999500',
            market: { marketId: '2' },
          },
        ],
      });

      const result = await module.findExpiredOpenPriceMarkets({
        creator,
        now: 1_800_000_000n,
      });

      expect(result).toEqual([
        {
          marketId: 1n,
          feedId:
            '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
          closeTime: 1_799_999_000n,
        },
        {
          marketId: 2n,
          feedId:
            '0xff5cc3d1bcd0c9c0e0eaccd5b67ea4f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
          closeTime: 1_799_999_500n,
        },
      ]);
    });
  });
});
