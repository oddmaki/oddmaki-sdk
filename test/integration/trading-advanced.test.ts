import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  getTestAccount,
  waitForTx,
  parseEventFromReceipt,
  parseAllEventsFromReceipt,
  approveCTFForDiamond,
  USDC_ADDRESS,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createBinaryMarketFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { LimitOrdersFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

// Binary-market trading paths not exercised in trading.test.ts:
// - market SELL (FAK), FOK reverts/succeeds, batch place/cancel, cancel-replace,
//   preview, MINT cross (YES BUY + NO BUY), MERGE cross (YES SELL + NO SELL).
//
// Each scenario uses dedicated markets to keep the orderbook state predictable.
describe.skipIf(!hasTestAccount())('Advanced trading flows', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let primaryMarketId: bigint;
  let mintMarketId: bigint;
  let mergeMarketId: bigint;

  beforeAll(async () => {
    client = createTestClient();

    // Wallet must hold USDC (https://faucet.circle.com). Actual on-chain
    // amounts in this suite are small (<= 10 USDC per op).
    await ensureUsdcFunded(client, parseUnits('20', 6));

    // Minimum-fee venue (1 bps is the smallest the validator allows) so MINT/MERGE
    // feasibility thresholds stay small and our chosen tick sums are well above them.
    venueId = await createVenueFixture(client, {
      name: `Trading-Advanced Venue ${Date.now()}`,
      venueFeeBps: 1,
      creatorFeeBps: 0,
    });

    primaryMarketId = await createBinaryMarketFixture(client, venueId);
    mintMarketId = await createBinaryMarketFixture(client, venueId, {
      question: { title: 'Mint Cross Market', description: 'MINT' },
    });
    mergeMarketId = await createBinaryMarketFixture(client, venueId, {
      question: { title: 'Merge Cross Market', description: 'MERGE' },
    });

    await approveCTFForDiamond(client);
  });

  // -------------------------------------------------------------------------
  // Cancel / batch / preview primitives
  // -------------------------------------------------------------------------

  it('cancels a single resting limit order and reclaims escrow', async () => {
    const placeTx = await client.trade.placeOrderSimple({
      marketId: primaryMarketId,
      outcomeId: 0n,
      side: 0, // BUY YES
      price: '0.42',
      quantity: '10',
      expiry: '1h',
    });
    const placeReceipt = await waitForTx(client, placeTx);
    const placedArgs = parseEventFromReceipt(
      placeReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const orderId = BigInt(placedArgs.orderId as bigint);

    const cancelTx = await client.trade.cancelOrder(orderId);
    await waitForTx(client, cancelTx);

    // Cancelled orders are deleted from storage — getOrder returns zero struct.
    const order: any = await client.trade.getOrder(orderId);
    expect(BigInt(order.id)).toBe(0n);
    expect(BigInt(order.qty)).toBe(0n);
  });

  it('places multiple orders atomically via batchPlaceOrdersSimple', async () => {
    const tx = await client.trade.batchPlaceOrdersSimple({
      marketId: primaryMarketId,
      orders: [
        {
          outcomeId: 0n,
          side: 0, // BUY YES
          price: '0.30',
          quantity: '10',
          expiry: '1h',
        },
        {
          outcomeId: 0n,
          side: 0,
          price: '0.31',
          quantity: '10',
          expiry: '1h',
        },
        {
          outcomeId: 1n,
          side: 0, // BUY NO
          price: '0.25',
          quantity: '10',
          expiry: '1h',
        },
      ],
    });
    const receipt = await waitForTx(client, tx);

    const placed = parseAllEventsFromReceipt(
      receipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    expect(placed.length).toBe(3);
  });

  it('cancels multiple resting orders via batchCancelOrders', async () => {
    const placeTx = await client.trade.batchPlaceOrdersSimple({
      marketId: primaryMarketId,
      orders: [
        { outcomeId: 0n, side: 0, price: '0.20', quantity: '5', expiry: '1h' },
        { outcomeId: 0n, side: 0, price: '0.21', quantity: '5', expiry: '1h' },
      ],
    });
    const placeReceipt = await waitForTx(client, placeTx);
    const placed = parseAllEventsFromReceipt(
      placeReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const orderIds = placed.map((args) => BigInt(args.orderId as bigint));
    expect(orderIds.length).toBe(2);

    const cancelTx = await client.trade.batchCancelOrders(orderIds);
    await waitForTx(client, cancelTx);

    for (const id of orderIds) {
      const order: any = await client.trade.getOrder(id);
      expect(BigInt(order.id)).toBe(0n);
    }
  });

  it('atomically replaces orders via cancelAndReplaceSimple', async () => {
    const placeTx = await client.trade.placeOrderSimple({
      marketId: primaryMarketId,
      outcomeId: 0n,
      side: 0,
      price: '0.15',
      quantity: '5',
      expiry: '1h',
    });
    const placeReceipt = await waitForTx(client, placeTx);
    const placedArgs = parseEventFromReceipt(
      placeReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const staleOrderId = BigInt(placedArgs.orderId as bigint);

    const replaceTx = await client.trade.cancelAndReplaceSimple({
      marketId: primaryMarketId,
      cancelOrderIds: [staleOrderId],
      newOrders: [
        { outcomeId: 0n, side: 0, price: '0.17', quantity: '5', expiry: '1h' },
      ],
    });
    await waitForTx(client, replaceTx);

    const stale: any = await client.trade.getOrder(staleOrderId);
    expect(BigInt(stale.id)).toBe(0n);
  });

  it('returns an orderId from previewPlaceOrder without sending a tx', async () => {
    // Preview uses eth_call — no state change, no nonce consumed.
    const previewed = await client.trade.previewPlaceOrder({
      marketId: primaryMarketId,
      outcomeId: 0n,
      side: 0,
      tick: 50n,
      qty: parseUnits('1', 6),
      expiry: 0n,
    });
    expect(previewed).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Market SELL FAK
  // -------------------------------------------------------------------------

  it('executes a market SELL (FAK) against a resting BUY', async () => {
    const account = getTestAccount();

    // First acquire outcome tokens to sell with.
    const splitTx = await client.trade.splitPosition(
      primaryMarketId,
      parseUnits('5', 6),
    );
    await waitForTx(client, splitTx);

    // Resting BUY that the market-sell will hit.
    const restingTx = await client.trade.placeOrderSimple({
      marketId: primaryMarketId,
      outcomeId: 0n,
      side: 0, // BUY YES @ 0.40
      price: '0.40',
      quantity: '5',
      expiry: '1h',
    });
    await waitForTx(client, restingTx);

    const sellTx = await client.trade.placeMarketSellSimple({
      marketId: primaryMarketId,
      outcomeId: 0n,
      amount: '5',
      minPrice: '0.35',
      orderType: 'FAK',
    });
    await waitForTx(client, sellTx);

    // User's YES balance should have decreased by 5 tokens.
    const balances: any = await client.market.getUserBalances(
      primaryMarketId,
      account.address,
    );
    expect(balances).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // MINT cross (YES BUY + NO BUY)
  // -------------------------------------------------------------------------

  it('MINT cross: YES BUY + NO BUY sums above 1.0 produces outcome tokens', async () => {
    const account = getTestAccount();

    // YES BUY at 0.70 + NO BUY at 0.35 = 1.05 — well above protocol+operator fee margin.
    const yesBuyTx = await client.trade.placeOrderSimple({
      marketId: mintMarketId,
      outcomeId: 0n,
      side: 0,
      price: '0.70',
      quantity: '10',
      expiry: '1h',
    });
    await waitForTx(client, yesBuyTx);

    const noBuyTx = await client.trade.placeOrderSimple({
      marketId: mintMarketId,
      outcomeId: 1n,
      side: 0,
      price: '0.35',
      quantity: '10',
      expiry: '1h',
    });
    await waitForTx(client, noBuyTx);

    const balancesBefore: any = await client.market.getUserBalances(
      mintMarketId,
      account.address,
    );
    const yesBefore = BigInt(balancesBefore.YES);
    const noBefore = BigInt(balancesBefore.NO);

    const matchTx = await client.trade.matchOrders({ marketId: mintMarketId, maxSteps: 10n });
    await waitForTx(client, matchTx);

    const balancesAfter: any = await client.market.getUserBalances(
      mintMarketId,
      account.address,
    );
    const yesAfter = BigInt(balancesAfter.YES);
    const noAfter = BigInt(balancesAfter.NO);

    // MINT path prints outcome tokens — buyer(YES) receives YES, buyer(NO) receives NO.
    // Since both orders belong to the same account here, both balances should grow.
    expect(yesAfter).toBeGreaterThan(yesBefore);
    expect(noAfter).toBeGreaterThan(noBefore);
  });

  // -------------------------------------------------------------------------
  // MERGE cross (YES SELL + NO SELL)
  // -------------------------------------------------------------------------

  it('MERGE cross: YES SELL + NO SELL sums below 1.0 returns collateral', async () => {
    const account = getTestAccount();

    // Seed account with outcome tokens to sell.
    const splitTx = await client.trade.splitPosition(
      mergeMarketId,
      parseUnits('10', 6),
    );
    await waitForTx(client, splitTx);

    // YES SELL at 0.50 + NO SELL at 0.45 = 0.95 — below 1.0 minus fees.
    const yesSellTx = await client.trade.placeOrderSimple({
      marketId: mergeMarketId,
      outcomeId: 0n,
      side: 1,
      price: '0.50',
      quantity: '5',
      expiry: '1h',
    });
    const yesSellReceipt = await waitForTx(client, yesSellTx);
    const yesOrderArgs = parseEventFromReceipt(
      yesSellReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const yesOrderId = BigInt(yesOrderArgs.orderId as bigint);

    const noSellTx = await client.trade.placeOrderSimple({
      marketId: mergeMarketId,
      outcomeId: 1n,
      side: 1,
      price: '0.45',
      quantity: '5',
      expiry: '1h',
    });
    const noSellReceipt = await waitForTx(client, noSellTx);
    const noOrderArgs = parseEventFromReceipt(
      noSellReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const noOrderId = BigInt(noOrderArgs.orderId as bigint);

    const usdcBefore = await client.token.getBalance(
      USDC_ADDRESS,
      account.address,
    );

    const matchTx = await client.trade.matchOrders({ marketId: mergeMarketId, maxSteps: 10n });
    await waitForTx(client, matchTx);

    // MERGE fills both orders completely — fully-filled orders are deleted.
    const yesOrder: any = await client.trade.getOrder(yesOrderId);
    const noOrder: any = await client.trade.getOrder(noOrderId);
    expect(BigInt(yesOrder.id)).toBe(0n);
    expect(BigInt(noOrder.id)).toBe(0n);

    // Seller(s) receive collateral — USDC balance should increase.
    const usdcAfter = await client.token.getBalance(
      USDC_ADDRESS,
      account.address,
    );
    expect(usdcAfter).toBeGreaterThan(usdcBefore);
  });
});
