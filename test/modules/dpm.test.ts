import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, stringToHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { DpmModule } from '../../src/modules/dpm';
import { clearDecimalsCache } from '../../src/utils/decimals';
import {
  DpmMarketFacetABI,
  DpmTradingFacetABI,
} from '../../src/contracts';
import type { OddMakiClientConfig } from '../../src/types';

describe('DpmModule', () => {
  let mod: DpmModule;
  const readContract = vi.fn();
  const simulateContract = vi.fn();
  const writeContract = vi.fn();
  const getAddresses = vi.fn();
  const getChainId = vi.fn();

  const diamond = '0x1111111111111111111111111111111111111111';
  const collateral = '0x4444444444444444444444444444444444444444' as `0x${string}`;
  const user = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;

  const config: OddMakiClientConfig = {
    chain: baseSepolia,
    transport: http(),
    diamondAddress: diamond,
    conditionalTokensAddress: '0x2222222222222222222222222222222222222222',
    subgraphEndpoint: 'https://example.com/subgraph',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: { readContract, simulateContract, getChainId } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walletClient: { getAddresses, writeContract } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearDecimalsCache();
    mod = new DpmModule(config);
    getAddresses.mockResolvedValue([user]);
    getChainId.mockResolvedValue(baseSepolia.id);
    simulateContract.mockResolvedValue({ request: { foo: 'bar' } });
    writeContract.mockResolvedValue('0xtxhash');
  });

  describe('createMarket()', () => {
    const params = {
      venueId: 1n,
      outcomes: ['Yes', 'No'],
      collateralToken: collateral,
      question: { title: 'Will it rain?', description: 'NYC, tomorrow' },
      closeTime: 1_780_000_000n,
    };

    it('encodes ancillary data and forwards createDpmMarket args', async () => {
      readContract.mockResolvedValueOnce({ marketCreationFee: 0n }); // getVenue

      const tx = await mod.createMarket(params);

      const expectedAncillary = stringToHex(
        'q:title:Will it rain?,description:NYC, tomorrow',
      );
      expect(simulateContract).toHaveBeenCalledWith({
        address: diamond,
        abi: DpmMarketFacetABI,
        functionName: 'createDpmMarket',
        args: [
          1n,
          expectedAncillary,
          ['Yes', 'No'],
          collateral,
          0n, // additionalReward default
          0n, // liveness default
          0n, // openTime default (immediate)
          1_780_000_000n,
          [], // tags
        ],
        account: user,
      });
      expect(tx).toBe('0xtxhash');
    });

    it('throws when allowance is below the creation fee', async () => {
      readContract
        .mockResolvedValueOnce({ marketCreationFee: 5_000_000n }) // getVenue
        .mockResolvedValueOnce(1_000_000n); // allowance < fee

      await expect(mod.createMarket(params)).rejects.toThrow(
        /Insufficient allowance/,
      );
    });
  });

  describe('createPriceMarket()', () => {
    it('defaults to ["Up","Down"] and forwards createDpmPriceMarket args', async () => {
      readContract.mockResolvedValueOnce({ marketCreationFee: 0n }); // getVenue

      await mod.createPriceMarket({
        venueId: 2n,
        pythFeedId:
          '0xfeed000000000000000000000000000000000000000000000000000000000000',
        closeTime: 1_780_000_000n,
        collateralToken: collateral,
        question: { title: 'ETH up?', description: '5m' },
      });

      const call = simulateContract.mock.calls[0][0];
      expect(call.functionName).toBe('createDpmPriceMarket');
      expect(call.args[5]).toEqual(['Up', 'Down']); // outcomes
      expect(call.args[2]).toBe(0n); // strikePrice default (deferred)
      expect(call.args[10]).toBe(0n); // resolutionWindow default
    });
  });

  describe('enter()', () => {
    it('passes minSharesOut through (slippage bound)', async () => {
      await mod.enter({ marketId: 7n, outcome: 1n, amount: 1_000_000n, minSharesOut: 950_000n });

      expect(simulateContract).toHaveBeenCalledWith({
        address: diamond,
        abi: DpmTradingFacetABI,
        functionName: 'enter',
        args: [7n, 1n, 1_000_000n, 950_000n],
        account: user,
      });
    });

    it('defaults minSharesOut to 0 when omitted (opt out)', async () => {
      await mod.enter({ marketId: 7n, outcome: 0n, amount: 500_000n });
      expect(simulateContract.mock.calls[0][0].args).toEqual([7n, 0n, 500_000n, 0n]);
    });
  });

  describe('enterSimple()', () => {
    it('parses the amount and derives minSharesOut from the quote minus tolerance', async () => {
      readContract
        .mockResolvedValueOnce({ collateralToken: collateral }) // getMarketTradingData
        .mockResolvedValueOnce(6) // erc20 decimals
        .mockResolvedValueOnce(1_000_000n); // quoteEntryShares

      await mod.enterSimple({
        marketId: 7n,
        outcome: 1n,
        amount: '1.0', // 6 decimals => 1_000_000
        maxSlippageBps: 100, // 1%
      });

      // quote 1_000_000 * (10000-100)/10000 = 990_000
      expect(simulateContract.mock.calls[0][0].args).toEqual([
        7n,
        1n,
        1_000_000n,
        990_000n,
      ]);
    });

    it('skips the quote and sends minSharesOut=0 when slippage is disabled', async () => {
      readContract
        .mockResolvedValueOnce({ collateralToken: collateral }) // getMarketTradingData
        .mockResolvedValueOnce(6); // decimals

      await mod.enterSimple({ marketId: 7n, outcome: 0n, amount: '2.5', maxSlippageBps: 0 });

      // No quoteEntryShares read should have happened (only 2 reads).
      expect(readContract).toHaveBeenCalledTimes(2);
      expect(simulateContract.mock.calls[0][0].args).toEqual([7n, 0n, 2_500_000n, 0n]);
    });
  });

  describe('trading wrappers', () => {
    it('enterIntent forwards to the trading facet', async () => {
      await mod.enterIntent({ marketId: 3n, outcome: 0n, amount: 100n });
      const call = simulateContract.mock.calls[0][0];
      expect(call.abi).toBe(DpmTradingFacetABI);
      expect(call.functionName).toBe('enterIntent');
      expect(call.args).toEqual([3n, 0n, 100n]);
    });

    it('claim forwards the marketId', async () => {
      await mod.claim(3n);
      expect(simulateContract.mock.calls[0][0].functionName).toBe('claim');
      expect(simulateContract.mock.calls[0][0].args).toEqual([3n]);
    });

    it('addOutcome forwards to the market facet', async () => {
      await mod.addOutcome(3n, 'Candidate C');
      const call = simulateContract.mock.calls[0][0];
      expect(call.abi).toBe(DpmMarketFacetABI);
      expect(call.functionName).toBe('addDpmOutcome');
      expect(call.args).toEqual([3n, 'Candidate C']);
    });
  });

  describe('reads', () => {
    it('get() maps the DpmMarket struct', async () => {
      readContract.mockResolvedValueOnce({
        outcomeCount: 2n,
        openTime: 100n,
        closeTime: 3700n,
        poolInitialized: true,
      });

      const dpm = await mod.get(9n);
      expect(dpm).toEqual({
        outcomeCount: 2n,
        openTime: 100n,
        closeTime: 3700n,
        poolInitialized: true,
      });
    });

    it('isDpmMarket() reads the flag', async () => {
      readContract.mockResolvedValueOnce(true);
      expect(await mod.isDpmMarket(9n)).toBe(true);
      expect(readContract.mock.calls[0][0].functionName).toBe('isDpmMarket');
    });

    it('getPoolState() reads M/N for each outcome', async () => {
      readContract
        .mockResolvedValueOnce({
          outcomeCount: 2n,
          openTime: 0n,
          closeTime: 1n,
          poolInitialized: true,
        }) // get()
        .mockResolvedValueOnce(60n) // outcome 0 collateral
        .mockResolvedValueOnce(60n) // outcome 0 shares
        .mockResolvedValueOnce(40n) // outcome 1 collateral
        .mockResolvedValueOnce(40n); // outcome 1 shares

      const state = await mod.getPoolState(9n);
      expect(state).toEqual([
        { outcome: 0, collateral: 60n, shares: 60n },
        { outcome: 1, collateral: 40n, shares: 40n },
      ]);
    });

    it('quoteEntryShares() forwards args', async () => {
      readContract.mockResolvedValueOnce(123n);
      const q = await mod.quoteEntryShares(9n, 1n, 1_000_000n);
      expect(q).toBe(123n);
      expect(readContract.mock.calls[0][0].args).toEqual([9n, 1n, 1_000_000n]);
    });
  });
});
