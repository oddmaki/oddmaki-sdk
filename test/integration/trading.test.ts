import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  createTestClient,
  getTestAccount,
  approveCTFForDiamond,
  waitForTx,
  parseEventFromReceipt,
  USDC_ADDRESS,
} from './helpers/setup';
import { ensureUsdcFunded } from './helpers/fixtures';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import { readSharedState } from './helpers/shared-state';
import { LimitOrdersFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

describe.skipIf(!hasTestAccount())('Trading lifecycle', () => {
  let client: OddMakiClient;
  let marketId: bigint;
  let buyOrderId: bigint;
  let sellOrderId: bigint;
  let lastTxHash: `0x${string}`;

  beforeAll(async () => {
    client = createTestClient();
    const state = readSharedState();
    marketId = BigInt(state.marketId);

    // Require pre-funded USDC (from https://faucet.circle.com) and approve
    // the Diamond. Splits 10 USDC + small limit orders fit comfortably here.
    await ensureUsdcFunded(client, parseUnits('20', 6));

    // Approve CTF for Diamond (needed for merge + sell orders)
    await approveCTFForDiamond(client);
  });

  // ---- Split ----

  it('should split USDC into YES + NO tokens', async () => {
    const account = getTestAccount();
    const amount = parseUnits('10', 6); // 10 USDC

    const txHash = await client.trade.splitPosition(marketId, amount);
    await waitForTx(client, txHash);

    const balances = await client.market.getUserBalances(marketId, account.address);
    expect(balances).toBeDefined();
    // After split, should have YES and NO tokens
    expect(BigInt((balances as any).YES)).toBeGreaterThanOrEqual(amount);
    expect(BigInt((balances as any).NO)).toBeGreaterThanOrEqual(amount);

    console.log(`  Split 10 USDC → YES=${(balances as any).YES}, NO=${(balances as any).NO}`);
  });

  // ---- Limit Orders ----

  it('should place a BUY YES limit order at 0.60', async () => {
    const txHash = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n, // YES
      side: 0, // BUY
      price: '0.60',
      quantity: '50',
      expiry: '24h',
    });

    const receipt = await waitForTx(client, txHash);
    const args = parseEventFromReceipt(receipt, LimitOrdersFacetABI as any, 'OrderPlaced');
    buyOrderId = BigInt(args.orderId as bigint);

    const order: any = await client.trade.getOrder(buyOrderId);
    expect(order).toBeDefined();
    // `tick` is the tick index (price / tickSize). 0.60 / 0.01 = 60.
    expect(BigInt(order.tick)).toBe(60n);

    console.log(`  BUY order placed: orderId=${buyOrderId}`);
  });

  it('should place a SELL YES limit order at 0.55 (crosses spread)', async () => {
    // Half the BUY size so the match leaves a partial residual we can inspect;
    // fully-filled orders are deleted from storage and return zero-struct.
    const txHash = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n, // YES
      side: 1, // SELL
      price: '0.55',
      quantity: '25',
      expiry: '24h',
    });

    const receipt = await waitForTx(client, txHash);
    const args = parseEventFromReceipt(receipt, LimitOrdersFacetABI as any, 'OrderPlaced');
    sellOrderId = BigInt(args.orderId as bigint);

    console.log(`  SELL order placed: orderId=${sellOrderId}`);
  });

  // ---- Matching ----

  it('should match crossing orders', async () => {
    const canMatch = await client.trade.canMatchOrders(marketId);
    expect(canMatch).toBeTruthy();

    const txHash = await client.trade.matchOrders({ marketId, maxSteps: 10n });
    await waitForTx(client, txHash);
    lastTxHash = txHash;

    // Verify orders are filled. Order struct has `qty` (remaining) and
    // `originalQty`; filled = originalQty - qty.
    const buyOrder: any = await client.trade.getOrder(buyOrderId);
    const filled = BigInt(buyOrder.originalQty) - BigInt(buyOrder.qty);
    expect(filled).toBeGreaterThan(0n);

    console.log(`  Orders matched: buyOrder filled=${filled}`);
  });

  // ---- Market Order ----

  it('should execute a market buy order (FAK)', async () => {
    // First place a resting SELL order to provide liquidity
    const restingTxHash = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n,
      side: 1, // SELL
      price: '0.70',
      quantity: '10',
      expiry: '24h',
    });
    await waitForTx(client, restingTxHash);

    // Now place a market buy against it
    const txHash = await client.trade.placeMarketOrderSimple({
      marketId,
      outcomeId: 0n,
      amount: '10',
      maxPrice: '0.75',
      orderType: 'FAK',
    });
    await waitForTx(client, txHash);
    lastTxHash = txHash;

    console.log(`  Market buy (FAK) executed: tx=${txHash}`);
  });

  // ---- Merge ----

  it('should merge YES + NO tokens back into USDC', async () => {
    const account = getTestAccount();

    const balancesBefore = await client.market.getUserBalances(marketId, account.address);
    const yesBefore = BigInt((balancesBefore as any).YES);
    const noBefore = BigInt((balancesBefore as any).NO);

    // Merge the minimum of YES and NO balances
    const mergeAmount = yesBefore < noBefore ? yesBefore : noBefore;

    if (mergeAmount > 0n) {
      const txHash = await client.trade.mergePositions(marketId, mergeAmount);
      await waitForTx(client, txHash);
      lastTxHash = txHash;

      const balancesAfter = await client.market.getUserBalances(marketId, account.address);
      const yesAfter = BigInt((balancesAfter as any).YES);
      const noAfter = BigInt((balancesAfter as any).NO);

      expect(yesAfter).toBeLessThan(yesBefore);
      expect(noAfter).toBeLessThan(noBefore);

      console.log(`  Merged ${mergeAmount} tokens. YES: ${yesBefore}→${yesAfter}, NO: ${noBefore}→${noAfter}`);
    } else {
      console.log('  No tokens to merge (balance is 0)');
    }
  });

  // ---- Subgraph verification ----

  it('should show trades in subgraph after indexing', async () => {
    await waitForSubgraphSync(client, lastTxHash);

    const response = await client.public.getTradeHistory({
      marketId,
      first: 20,
    });

    expect(response).toBeDefined();
    expect(response.trades).toBeDefined();
    expect(response.trades.length).toBeGreaterThan(0);

    const trade = response.trades[0];
    expect(trade.outcome).toBeDefined();
    // Subgraph Trade entity uses `tradeType` (NORMAL/MINT/MERGE), not `side`.
    expect((trade as any).tradeType).toBeDefined();
    expect(trade.tick).toBeDefined();
    expect(trade.amount).toBeDefined();

    console.log(`  Found ${response.trades.length} trades in subgraph`);
  });

  it('should show orderbook state in subgraph', async () => {
    const response = await client.public.getTopOfBook(marketId);

    expect(response).toBeDefined();
    expect(response.topOfBooks).toBeDefined();
    expect(Array.isArray(response.topOfBooks)).toBe(true);

    console.log(`  Top of book entries: ${response.topOfBooks.length}`);
  });
});
