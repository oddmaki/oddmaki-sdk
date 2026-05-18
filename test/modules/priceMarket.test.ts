import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, stringToHex } from 'viem';
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
        0n, // strikePrice (deferred sentinel)
        0n, // openPriceTime (not yet captured)
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
        openPriceTime: 0n,
      });
    });
  });

  describe('createPyth()', () => {
    const baseParams = {
      venueId: 1n,
      pythFeedId:
        '0xfeed000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      closeTime: 1_780_000_000n,
      tickSize: 10_000_000_000_000_000n,
      collateralToken:
        '0x4444444444444444444444444444444444444444' as `0x${string}`,
      question: { title: 'ETH Up or Down', description: '5m smoke' },
    };

    function mockVenueWithZeroFee() {
      readContract.mockResolvedValueOnce({ marketCreationFee: 0n });
    }

    it('immediate deferred: openTime=0, strikePrice=0, no value sent, no Hermes fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      mockVenueWithZeroFee();

      await mod.createPyth(baseParams);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'createPriceMarketPyth',
          args: [
            baseParams.venueId,
            baseParams.pythFeedId,
            0n, // strikePrice defaults to 0
            0n, // openTime defaults to 0
            baseParams.closeTime,
            ['Up', 'Down'], // default outcomes
            baseParams.tickSize,
            baseParams.collateralToken,
            stringToHex(
              `q:title:${baseParams.question.title},description:${baseParams.question.description}`,
            ),
            0n, // liveness
            [], // tags
            0n, // resolutionWindow
          ],
        }),
      );
      // Critically: no `value` in the simulation args — creation is non-payable.
      const call = simulateContract.mock.calls[0][0];
      expect(call.value).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it('scheduled deferred: openTime in the future, strikePrice=0', async () => {
      mockVenueWithZeroFee();
      const future = 1_779_999_999n;
      const close = 1_780_000_300n;

      await mod.createPyth({
        ...baseParams,
        openTime: future,
        closeTime: close,
      });

      const args = simulateContract.mock.calls[0][0].args;
      expect(args[2]).toBe(0n); // strikePrice
      expect(args[3]).toBe(future); // openTime
      expect(args[4]).toBe(close); // closeTime
    });

    it('explicit strike: strikePrice > 0, openTime ignored on chain', async () => {
      mockVenueWithZeroFee();
      const strike = 300_000_000_000n;

      await mod.createPyth({
        ...baseParams,
        strikePrice: strike,
        outcomes: ['Above', 'Below'],
      });

      const args = simulateContract.mock.calls[0][0].args;
      expect(args[2]).toBe(strike);
      expect(args[3]).toBe(0n); // openTime stays 0
      expect(args[5]).toEqual(['Above', 'Below']);
    });

    it('forwards resolutionWindow when provided', async () => {
      mockVenueWithZeroFee();
      await mod.createPyth({ ...baseParams, resolutionWindow: 120n });
      const args = simulateContract.mock.calls[0][0].args;
      expect(args[11]).toBe(120n);
    });
  });

  describe('resolvePyth()', () => {
    const FEED =
      '0xfeed000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    function mockHermesSequence(payloads: string[]) {
      let call = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = vi.fn(async () => {
        const data = payloads[call++] ?? payloads[payloads.length - 1];
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            binary: { encoding: 'hex', data: [data] },
            parsed: [
              {
                id: FEED.slice(2),
                price: {
                  price: '1000',
                  conf: '1',
                  expo: -8,
                  publish_time: 1_770_000_000,
                },
              },
            ],
          }),
        };
      }) as any;
    }

    function mockGetPriceMarket(opts: {
      strikePrice: bigint;
      openTime: bigint;
      closeTime: bigint;
      resolved?: boolean;
    }) {
      readContract.mockResolvedValueOnce([
        FEED,
        0, // PYTH
        opts.openTime,
        opts.closeTime,
        -8,
        0n,
        60n,
        opts.resolved ?? false,
        opts.strikePrice,
        0n,
      ]);
    }

    function mockPythAddressAndFee(fee: bigint) {
      readContract.mockResolvedValueOnce(
        '0x5555555555555555555555555555555555555555',
      ); // getPythContract
      readContract.mockResolvedValueOnce(fee); // getUpdateFee
    }

    it('explicit-strike market: fetches one close-window VAA only', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_780_000_400 * 1000);

      mockGetPriceMarket({
        strikePrice: 300_000_000_000n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
      });
      mockHermesSequence(['deadbeef']);
      mockPythAddressAndFee(2n);

      await mod.resolvePyth(42n);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const fetchUrl = (globalThis.fetch as any).mock.calls[0][0];
      expect(fetchUrl).toContain('/1780000000?'); // close window only

      const args = simulateContract.mock.calls[0][0].args;
      expect(args[1]).toEqual(['0xdeadbeef']);
    });

    it('deferred market: fetches both open- and close-window VAAs', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_780_000_400 * 1000);

      mockGetPriceMarket({
        strikePrice: 0n, // deferred sentinel
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
      });
      mockHermesSequence(['cafebabe', 'deadbeef']); // first call = close, second = open
      mockPythAddressAndFee(4n);

      await mod.resolvePyth(43n);

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const urls = (globalThis.fetch as any).mock.calls.map(
        (c: any) => c[0],
      );
      // First call inside resolvePyth is the close VAA, then open.
      expect(urls[0]).toContain('/1780000000?');
      expect(urls[1]).toContain('/1770000000?');

      const args = simulateContract.mock.calls[0][0].args;
      // Open VAA first in the submitted array, then close.
      expect(args[1]).toEqual(['0xdeadbeef', '0xcafebabe']);
    });

    it('rejects when already resolved', async () => {
      mockGetPriceMarket({
        strikePrice: 100n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
        resolved: true,
      });
      await expect(mod.resolvePyth(44n)).rejects.toThrow(
        /already resolved/i,
      );
    });

    it('rejects when closeTime not reached', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000 * 1000);
      mockGetPriceMarket({
        strikePrice: 100n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
      });
      await expect(mod.resolvePyth(45n)).rejects.toThrow(
        /Close time not reached/i,
      );
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

  describe('fetchProjectedOpenPrice()', () => {
    const FEED =
      '0xfeed000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    function mockGetPriceMarket(opts: {
      strikePrice: bigint;
      openTime: bigint;
      closeTime: bigint;
      resolved?: boolean;
      resolutionWindow?: bigint;
    }) {
      readContract.mockResolvedValueOnce([
        FEED,
        0,
        opts.openTime,
        opts.closeTime,
        -8,
        0n,
        opts.resolutionWindow ?? 60n,
        opts.resolved ?? false,
        opts.strikePrice,
        0n,
      ]);
    }

    function mockHermesProjection(price: string, publishTime: number) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          binary: { encoding: 'hex', data: ['deadbeef'] },
          parsed: [
            {
              id: FEED.slice(2),
              price: {
                price,
                conf: '1',
                expo: -8,
                publish_time: publishTime,
              },
            },
          ],
        }),
      })) as any;
    }

    it('returns null for resolved markets', async () => {
      mockGetPriceMarket({
        strikePrice: 100n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
        resolved: true,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await mod.fetchProjectedOpenPrice(1n);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns null for explicit-strike markets', async () => {
      mockGetPriceMarket({
        strikePrice: 300_000_000_000n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await mod.fetchProjectedOpenPrice(2n);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns null when openTime is in the future', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_770_000_000 * 1000);
      mockGetPriceMarket({
        strikePrice: 0n,
        openTime: 1_770_000_100n,
        closeTime: 1_780_000_000n,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await mod.fetchProjectedOpenPrice(3n);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns canonical=false when openTime reached but window not elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime((1_770_000_030) * 1000);
      mockGetPriceMarket({
        strikePrice: 0n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
        resolutionWindow: 60n,
      });
      mockHermesProjection('209675501250', 1_770_000_001);

      const result = await mod.fetchProjectedOpenPrice(4n);

      expect(result).toEqual({
        price: 209_675_501_250n,
        publishTime: 1_770_000_001n,
        expo: -8,
        canonical: false,
        openTime: 1_770_000_000n,
      });
    });

    it('returns canonical=true once openTime + window has elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime((1_770_000_060) * 1000);
      mockGetPriceMarket({
        strikePrice: 0n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
        resolutionWindow: 60n,
      });
      mockHermesProjection('209675501250', 1_770_000_001);

      const result = await mod.fetchProjectedOpenPrice(5n);
      expect(result?.canonical).toBe(true);
    });

    it('queries Hermes at the market openTime, not now', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_770_005_000 * 1000);
      mockGetPriceMarket({
        strikePrice: 0n,
        openTime: 1_770_000_000n,
        closeTime: 1_780_000_000n,
      });
      mockHermesProjection('100', 1_770_000_001);

      await mod.fetchProjectedOpenPrice(6n);

      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).toContain('/1770000000?');
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
      mockHermes(now - 600);

      const result = await mod.fetchFreshPythUpdate(FEED_ID, {
        maxAgeSeconds: 60,
        maxAttempts: 3,
      });

      expect(result.publishTime).toBe(BigInt(now - 600));
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
