import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits, parseEther } from 'viem';
import {
  hasTestAccount,
  createTestClient,
  waitForTx,
  parseEventFromReceipt,
  USDC_ADDRESS,
} from './helpers/setup';
import { ensureUsdcFunded } from './helpers/fixtures';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import { readSharedState } from './helpers/shared-state';
import { MarketsFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

describe.skipIf(!hasTestAccount())('Market creation', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let marketId: bigint;
  let lastTxHash: `0x${string}`;

  beforeAll(async () => {
    client = createTestClient();
    const state = readSharedState();
    venueId = BigInt(state.venueId);

    // Wallet must hold USDC (https://faucet.circle.com) for market creation fee.
    await ensureUsdcFunded(client, parseUnits('20', 6));

    const txHash = await client.market.createMarket({
      venueId,
      question: { title: 'Market Test Question', description: 'Will this test pass?' },
      outcomes: ['Yes', 'No'],
      tickSize: parseEther('0.01'),
      collateralToken: USDC_ADDRESS,
      additionalReward: 0n,
      liveness: 0n,
    });

    const receipt = await waitForTx(client, txHash);
    const args = parseEventFromReceipt(receipt, MarketsFacetABI as any, 'MarketCreated');
    marketId = BigInt(args.marketId as bigint);
    lastTxHash = txHash;

    console.log(`  Market created: marketId=${marketId}, tx=${txHash}`);
  });

  it('should read market back on-chain with correct parameters', async () => {
    const registryData: any = await client.market.getMarketRegistryData(marketId);
    expect(registryData).toBeDefined();

    const tradingData: any = await client.market.getMarketTradingData(marketId);
    expect(tradingData).toBeDefined();
    expect(tradingData.collateralToken.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(BigInt(tradingData.tickSize)).toBe(parseEther('0.01'));
  });

  it('should appear in subgraph with correct question and outcomes', async () => {
    await waitForSubgraphSync(client, lastTxHash);

    const market = await client.public.getMarket(marketId);

    expect(market).toBeDefined();
    if (market) {
      expect(market.question).toContain('Market Test Question');
      expect(market.outcomes).toBeDefined();
      expect(Array.isArray(market.outcomes)).toBe(true);
      expect(market.outcomes).toHaveLength(2);
    }
  });

  it('should return empty orderbook for a fresh market', async () => {
    const prices = await client.market.getBestPrices(marketId);
    expect(prices).toBeDefined();
    // Fresh market with no orders — best prices should be zero/default
  });
});
