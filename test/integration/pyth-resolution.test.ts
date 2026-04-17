import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits, parseEther } from 'viem';
import {
  hasTestAccount,
  createTestClient,
  mintAndApproveUSDC,
  waitForTx,
  parseEventFromReceipt,
  USDC_ADDRESS,
} from './helpers/setup';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import { readSharedState } from './helpers/shared-state';
import { PythResolutionFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

// ETH/USD Pyth feed ID
const ETH_USD_FEED_ID =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' as const;

describe.skipIf(!hasTestAccount())('Pyth price market', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let marketId: bigint;

  beforeAll(async () => {
    client = createTestClient();
    const state = readSharedState();
    venueId = BigInt(state.venueId);

    // Mint + approve for market creation fee
    await mintAndApproveUSDC(client, parseUnits('100', 6));

    // Create a strike market (no Pyth update data needed at creation time)
    // Close time = 5 minutes from now (minimum allowed)
    const closeTime = BigInt(Math.floor(Date.now() / 1000)) + 300n;

    const txHash = await client.priceMarket.createPyth({
      venueId,
      pythFeedId: ETH_USD_FEED_ID,
      strikePrice: parseUnits('3000', 8), // $3,000 with 8 decimal exponent
      closeTime,
      outcomes: ['Above', 'Below'],
      tickSize: parseEther('0.01'),
      collateralToken: USDC_ADDRESS,
      question: {
        title: 'ETH above $3,000?',
        description: 'Will ETH/USD be above $3,000 at close time?',
      },
      liveness: 0n,
    });

    const receipt = await waitForTx(client, txHash);
    const args = parseEventFromReceipt(
      receipt,
      PythResolutionFacetABI as any,
      'MarketCreated',
    );
    marketId = BigInt(args.marketId as bigint);

    console.log(`  Pyth market created: marketId=${marketId}, closeTime=${closeTime}`);
  });

  it('should read back as a Pyth price market', async () => {
    const isPyth = await client.priceMarket.isPriceMarket(marketId);
    expect(isPyth).toBe(true);
  });

  it('should return correct price market data', async () => {
    const pm = await client.priceMarket.get(marketId);

    expect(pm).toBeDefined();
    expect(pm.feedId.toLowerCase()).toBe(ETH_USD_FEED_ID.toLowerCase());
    expect(pm.resolved).toBe(false);
    expect(pm.strikePrice).toBe(parseUnits('3000', 8));
    expect(pm.closeTime).toBeGreaterThan(0n);
  });

  it('should report canResolve = false before closeTime', async () => {
    const canResolve = await client.priceMarket.canResolve(marketId);
    expect(canResolve).toBe(false);
  });

  // Resolution requires waiting for closeTime (5 minutes minimum).
  // Un-skip this test for manual/extended runs.
  it.skip('should resolve Pyth market after close time (requires 5-min wait)', async () => {
    // Wait for close time to pass
    const pm = await client.priceMarket.get(marketId);
    const waitMs = Number(pm.closeTime - BigInt(Math.floor(Date.now() / 1000))) * 1000;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs + 5000)); // +5s buffer
    }

    const txHash = await client.priceMarket.resolvePyth(marketId);
    await waitForTx(client, txHash);

    const resolved = await client.priceMarket.get(marketId);
    expect(resolved.resolved).toBe(true);
  });
});
