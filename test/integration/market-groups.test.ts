import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  waitForTx,
  parseEventFromReceipt,
  approveCTFForDiamond,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createActivatedMarketGroupFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import { LimitOrdersFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

// Market groups (neg-risk) are the protocol's answer to multi-outcome markets:
// N mutually exclusive binary markets sharing collateral via WrappedCollateralToken.
// This suite covers creation, activation, reads, and live trading on a group market.
describe.skipIf(!hasTestAccount())('Market groups', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let groupId: bigint;
  let marketIds: bigint[];
  let lastTxHash: `0x${string}`;

  beforeAll(async () => {
    client = createTestClient();

    await ensureUsdcFunded(client, parseUnits('500', 6));
    await approveCTFForDiamond(client);

    venueId = await createVenueFixture(client, {
      name: `Group Test Venue ${Date.now()}`,
    });

    const fixture = await createActivatedMarketGroupFixture(client, venueId, 2, {
      title: `Group ${Date.now()}`,
      description: 'Two-option neg-risk group',
      marketNames: ['Candidate A', 'Candidate B'],
    });
    groupId = fixture.groupId;
    marketIds = fixture.marketIds;
    lastTxHash = fixture.lastTxHash;

    await waitForSubgraphSync(client, lastTxHash);
  });

  it('reads group metadata via getMarketGroup', async () => {
    const group: any = await client.market.getMarketGroup(groupId);
    expect(group).toBeDefined();
    // totalMarkets should match the number we added (2)
    expect(BigInt(group.totalMarkets ?? group[2] ?? group.totalMarkets)).toBe(2n);
  });

  it('lists the group member market ids via getGroupMarketIds', async () => {
    const ids = (await client.market.getGroupMarketIds(groupId)) as readonly bigint[];
    expect(ids.length).toBe(2);
    for (const id of marketIds) {
      expect(ids.map((x) => BigInt(x))).toContainEqual(id);
    }
  });

  it('exposes child-market metadata via getMarketGroupItem', async () => {
    const item: any = await client.market.getMarketGroupItem(marketIds[0]);
    expect(item).toBeDefined();
    // marketName should be our fixture label
    const name = item.marketName ?? item[0];
    expect(typeof name).toBe('string');
    expect((name as string).length).toBeGreaterThan(0);
  });

  it('places and matches a BUY/SELL cross on a group member market', async () => {
    const groupMarketId = marketIds[0];

    // Group markets use WrappedCollateralToken under the hood — splitting USDC
    // here backs the SELL order with outcome tokens.
    const splitTx = await client.trade.splitPosition(
      groupMarketId,
      parseUnits('10', 6),
    );
    await waitForTx(client, splitTx);

    // Two opposite orders from the same account — they will self-cross.
    const buyTx = await client.trade.placeOrderSimple({
      marketId: groupMarketId,
      outcomeId: 0n,
      side: 0, // BUY YES @ 0.60
      price: '0.60',
      quantity: '10',
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
      marketId: groupMarketId,
      outcomeId: 0n,
      side: 1, // SELL YES @ 0.55 (partial-fill qty so buy keeps a residual)
      price: '0.55',
      quantity: '5',
      expiry: '1h',
    });
    await waitForTx(client, sellTx);

    const matchTx = await client.trade.matchOrders({
      marketId: groupMarketId,
      maxSteps: 10n,
    });
    await waitForTx(client, matchTx);

    const order: any = await client.trade.getOrder(buyOrderId);
    const filled = BigInt(order.originalQty) - BigInt(order.qty);
    expect(filled).toBeGreaterThan(0n);
  });

  it('indexes the group and its markets in the subgraph', async () => {
    await waitForSubgraphSync(client, lastTxHash);

    const group: any = await client.public.getMarketGroup(groupId);
    expect(group).toBeDefined();
    const groupEntity = group.marketGroup ?? group;
    expect(groupEntity).toBeDefined();

    const markets: any = await client.public.getGroupMarkets({ groupId });
    expect(markets).toBeDefined();
    expect(Array.isArray(markets.markets)).toBe(true);
    expect(markets.markets.length).toBe(2);
  });
});
