import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  getTestAccount,
  waitForTx,
  parseEventFromReceipt,
  approveCTFForDiamond,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createPythStrikeMarketFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { LimitOrdersFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

// Price markets are binary (Above/Below) markets resolved by a Pyth feed at
// closeTime. Trading mechanics before closeTime are identical to regular
// binary markets — this suite exercises the open trading window.
describe.skipIf(!hasTestAccount())('Price-market trading', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let marketId: bigint;

  beforeAll(async () => {
    client = createTestClient();

    await ensureUsdcFunded(client, parseUnits('200', 6));
    await approveCTFForDiamond(client);

    venueId = await createVenueFixture(client, {
      name: `Price-Market Venue ${Date.now()}`,
    });

    const fixture = await createPythStrikeMarketFixture(client, venueId, {
      strikePrice: parseUnits('3000', 8),
    });
    marketId = fixture.marketId;
  });

  it('reports isPriceMarket = true for a Pyth-resolved market', async () => {
    const isPm = await client.priceMarket.isPriceMarket(marketId);
    expect(isPm).toBe(true);
  });

  it('exposes market data via priceMarket.get', async () => {
    const pm = await client.priceMarket.get(marketId);
    expect(pm).toBeDefined();
    expect(pm.strikePrice).toBe(parseUnits('3000', 8));
    expect(pm.resolved).toBe(false);
    expect(pm.closeTime).toBeGreaterThan(0n);
  });

  it('splits collateral into Above/Below outcome tokens', async () => {
    const account = getTestAccount();
    const amount = parseUnits('10', 6);

    const tx = await client.trade.splitPosition(marketId, amount);
    await waitForTx(client, tx);

    const balances: any = await client.market.getUserBalances(marketId, account.address);
    // Price markets use the first two outcomes as YES/NO slots from SDK's perspective.
    expect(BigInt((balances as any).YES)).toBeGreaterThanOrEqual(amount);
    expect(BigInt((balances as any).NO)).toBeGreaterThanOrEqual(amount);
  });

  it('matches a limit-order cross on a price market', async () => {
    const buyTx = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n, // Above
      side: 0,
      price: '0.55',
      quantity: '5',
      expiry: '1h',
    });
    const buyReceipt = await waitForTx(client, buyTx);
    const buyOrder = parseEventFromReceipt(
      buyReceipt,
      LimitOrdersFacetABI as any,
      'OrderPlaced',
    );
    const buyOrderId = BigInt(buyOrder.orderId as bigint);

    const sellTx = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n,
      side: 1,
      price: '0.50',
      quantity: '3', // partial fill
      expiry: '1h',
    });
    await waitForTx(client, sellTx);

    const matchTx = await client.trade.matchOrders({ marketId, maxSteps: 5n });
    await waitForTx(client, matchTx);

    const order: any = await client.trade.getOrder(buyOrderId);
    const filled = BigInt(order.originalQty) - BigInt(order.qty);
    expect(filled).toBeGreaterThan(0n);
  });

  it('executes a FAK market buy against a resting Above sell', async () => {
    const restingTx = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n,
      side: 1, // SELL Above @ 0.75
      price: '0.75',
      quantity: '4',
      expiry: '1h',
    });
    await waitForTx(client, restingTx);

    const fakTx = await client.trade.placeMarketOrderSimple({
      marketId,
      outcomeId: 0n,
      amount: '3',
      maxPrice: '0.80',
      orderType: 'FAK',
    });
    await waitForTx(client, fakTx);
  });

  it('canResolve is false before closeTime', async () => {
    const canResolve = await client.priceMarket.canResolve(marketId);
    expect(canResolve).toBe(false);
  });
});
