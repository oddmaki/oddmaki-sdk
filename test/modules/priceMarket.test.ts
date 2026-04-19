import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { PriceMarketModule, FeedProvider } from '../../src/modules/priceMarket';
import type { OddMakiClientConfig } from '../../src/types';

describe('PriceMarketModule', () => {
  let mod: PriceMarketModule;
  const readContract = vi.fn();
  const simulateContract = vi.fn();
  const writeContract = vi.fn();
  const getAddresses = vi.fn();

  const config: OddMakiClientConfig = {
    chain: baseSepolia,
    transport: http(),
    diamondAddress: '0x1111111111111111111111111111111111111111',
    conditionalTokensAddress: '0x2222222222222222222222222222222222222222',
    subgraphEndpoint: 'https://example.com/subgraph',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: { readContract, simulateContract } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walletClient: { getAddresses, writeContract } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mod = new PriceMarketModule(config);
    getAddresses.mockResolvedValue([
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    ]);
    simulateContract.mockResolvedValue({ request: { foo: 'bar' } });
    writeContract.mockResolvedValue('0xtxhash');
  });

  describe('get()', () => {
    it('hydrates PriceMarketData including openPriceTime', async () => {
      readContract.mockResolvedValueOnce([
        '0xfeed000000000000000000000000000000000000000000000000000000000000',
        0, // FeedProvider.PYTH
        100n, // openTime
        3700n, // closeTime
        -8, // priceExpo
        0n, // finalPrice
        60n, // resolutionWindow
        false, // resolved
        0n, // strikePrice
        99n, // openPriceTime (new)
      ]);

      const pm = await mod.get(1n);

      expect(pm).toEqual({
        feedId:
          '0xfeed000000000000000000000000000000000000000000000000000000000000',
        feedProvider: FeedProvider.PYTH,
        openTime: 100n,
        closeTime: 3700n,
        priceExpo: -8,
        finalPrice: 0n,
        resolutionWindow: 60n,
        resolved: false,
        strikePrice: 0n,
        openPriceTime: 99n,
      });
    });
  });

  describe('getOpenMaxStaleness()', () => {
    it('reads the on-chain staleness window', async () => {
      readContract.mockResolvedValueOnce(300n);
      const result = await mod.getOpenMaxStaleness();
      expect(result).toBe(300n);
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: config.diamondAddress,
          functionName: 'getOpenMaxStaleness',
        }),
      );
    });
  });

  describe('setOpenMaxStaleness()', () => {
    it('simulates + writes with the owner account', async () => {
      await mod.setOpenMaxStaleness(600n);
      expect(simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: config.diamondAddress,
          functionName: 'setOpenMaxStaleness',
          args: [600n],
        }),
      );
      expect(writeContract).toHaveBeenCalledWith({ foo: 'bar' });
    });
  });

  describe('setPythContract()', () => {
    it('simulates + writes with the new Pyth address', async () => {
      const pyth = '0x3333333333333333333333333333333333333333' as const;
      await mod.setPythContract(pyth);
      expect(simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'setPythContract',
          args: [pyth],
        }),
      );
    });
  });

  describe('Hermes helpers', () => {
    const FEED_ID =
      '0xabcdef0000000000000000000000000000000000000000000000000000000000' as const;
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    function mockHermes(publishTime: number, payloadHex = 'deadbeef') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          binary: { encoding: 'hex', data: [payloadHex] },
          parsed: [
            {
              id: FEED_ID.slice(2),
              price: {
                price: '1000',
                conf: '1',
                expo: -8,
                publish_time: publishTime,
              },
            },
          ],
        }),
      })) as any;
    }

    it('fetchPythLatestUpdate returns updateData and publishTime', async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      mockHermes(now - 10);

      const result = await mod.fetchPythLatestUpdate(FEED_ID);

      expect(result.updateData).toEqual(['0xdeadbeef']);
      expect(result.publishTime).toBe(BigInt(now - 10));
      expect(result.fetchedAt).toBe(BigInt(now));
    });

    it('fetchFreshPythUpdate returns cached update when fresh', async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchSpy = (globalThis.fetch = vi.fn() as any);

      const cached = {
        updateData: ['0xcafebabe' as `0x${string}`],
        publishTime: BigInt(now - 30),
        fetchedAt: BigInt(now - 30),
      };

      const result = await mod.fetchFreshPythUpdate(FEED_ID, {
        maxAgeSeconds: 120,
        cached,
      });

      expect(result).toBe(cached);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetchFreshPythUpdate re-fetches when cache is stale', async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      mockHermes(now - 5);

      const stale = {
        updateData: ['0xcafebabe' as `0x${string}`],
        publishTime: BigInt(now - 500),
        fetchedAt: BigInt(now - 500),
      };

      const result = await mod.fetchFreshPythUpdate(FEED_ID, {
        maxAgeSeconds: 120,
        cached: stale,
      });

      expect(result.publishTime).toBe(BigInt(now - 5));
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fetchFreshPythUpdate retries up to maxAttempts on stale feed', async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
      // Hermes keeps returning an old VAA — simulate a quiet feed.
      mockHermes(now - 600);

      const result = await mod.fetchFreshPythUpdate(FEED_ID, {
        maxAgeSeconds: 60,
        maxAttempts: 3,
      });

      // Returns last attempt even if still stale, lets caller decide.
      expect(result.publishTime).toBe(BigInt(now - 600));
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
