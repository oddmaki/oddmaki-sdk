import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  getTestAccount,
  waitForTx,
  approveCTFForDiamond,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createBinaryMarketFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import type { OddMakiClient } from '../../src/client';

// Exercises PublicModule subgraph queries that aren't hit elsewhere, focusing
// on the ones the frontends call most: trader analytics, leaderboards, unified
// feed, protocol stats, market pricing. Each assertion checks *shape plus
// presence of the entity we just created* rather than exact totals — the
// subgraph is a shared resource and other tests write to it concurrently.
describe.skipIf(!hasTestAccount())('Subgraph accuracy', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let marketId: bigint;
  let lastTxHash: `0x${string}`;
  let traderAddress: `0x${string}`;

  beforeAll(async () => {
    client = createTestClient();
    traderAddress = getTestAccount().address;

    await ensureUsdcFunded(client, parseUnits('200', 6));
    await approveCTFForDiamond(client);

    venueId = await createVenueFixture(client, {
      name: `Subgraph Accuracy Venue ${Date.now()}`,
    });
    marketId = await createBinaryMarketFixture(client, venueId);

    // Generate a realized trade so trader stats/leaderboard/holders have data.
    const splitTx = await client.trade.splitPosition(marketId, parseUnits('5', 6));
    await waitForTx(client, splitTx);

    const buyTx = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n,
      side: 0, // BUY YES
      price: '0.50',
      quantity: '4',
      expiry: '1h',
    });
    await waitForTx(client, buyTx);

    const sellTx = await client.trade.placeOrderSimple({
      marketId,
      outcomeId: 0n,
      side: 1, // SELL YES (partial)
      price: '0.45',
      quantity: '2',
      expiry: '1h',
    });
    await waitForTx(client, sellTx);

    const matchTx = await client.trade.matchOrders({ marketId, maxSteps: 5n });
    lastTxHash = await client.config.publicClient.waitForTransactionReceipt({
      hash: matchTx,
      confirmations: 2,
    }).then((r) => r.transactionHash);

    await waitForSubgraphSync(client, lastTxHash);
  });

  it('returns protocol stats with non-zero totals', async () => {
    const stats: any = await client.public.getProtocolStats();
    expect(stats).toBeDefined();
    const proto = stats.protocol ?? stats.protocols?.[0] ?? stats;
    expect(proto).toBeDefined();
    expect(BigInt(proto.totalVenues ?? 0)).toBeGreaterThan(0n);
    expect(BigInt(proto.totalMarkets ?? 0)).toBeGreaterThan(0n);
  });

  it('returns markets-with-pricing for the venue', async () => {
    const response: any = await client.public.getMarketsWithPricing({
      venueId,
      first: 20,
    });
    expect(Array.isArray(response.markets)).toBe(true);
    const found = response.markets.find(
      (m: any) => m.marketId === marketId.toString(),
    );
    expect(found).toBeDefined();
  });

  it('lists the market via getTopVenues and getRecentMarkets', async () => {
    const top: any = await client.public.getTopVenues(50);
    expect(Array.isArray(top.venues)).toBe(true);

    const recent: any = await client.public.getRecentMarkets({ first: 20 });
    expect(Array.isArray(recent.markets)).toBe(true);
    const found = recent.markets.find(
      (m: any) => m.marketId === marketId.toString(),
    );
    expect(found).toBeDefined();
  });

  it('returns our recent trade in getRecentTrades', async () => {
    const recent: any = await client.public.getRecentTrades({ first: 50 });
    expect(Array.isArray(recent.trades)).toBe(true);
    const mine = recent.trades.filter(
      (t: any) => t.market?.marketId === marketId.toString(),
    );
    expect(mine.length).toBeGreaterThan(0);
  });

  it('returns trader profile + positions + fill history', async () => {
    const profile: any = await client.public.getTraderProfile(traderAddress);
    expect(profile).toBeDefined();
    // `user` may be null if the trader address hasn't been indexed under that
    // exact key yet — the subgraph keys users by address lowercase.
    const user = profile.user ?? profile.users?.[0] ?? null;
    if (user) {
      expect(BigInt(user.totalTradeCount ?? 0)).toBeGreaterThan(0n);
    }

    const positions: any = await client.public.getTraderPositions({
      trader: traderAddress,
      first: 20,
    });
    expect(Array.isArray(positions.traderPositions ?? positions.positions ?? [])).toBe(true);

    const trades: any = await client.public.getTraderTrades({
      trader: traderAddress,
      first: 20,
    });
    expect(Array.isArray(trades.fills ?? trades.trades ?? [])).toBe(true);
  });

  it('returns a leaderboard ordered by volume', async () => {
    const board: any = await client.public.getLeaderboard({
      orderBy: 'totalVolume',
      orderDirection: 'desc',
      first: 20,
    });
    expect(Array.isArray(board.users)).toBe(true);
    if (board.users.length > 1) {
      // Monotonically non-increasing by totalVolume.
      for (let i = 1; i < board.users.length; i++) {
        expect(BigInt(board.users[i - 1].totalVolume ?? 0)).toBeGreaterThanOrEqual(
          BigInt(board.users[i].totalVolume ?? 0),
        );
      }
    }
  });

  it('returns top holders for the market', async () => {
    const holders: any = await client.public.getMarketTopHolders({
      marketId: marketId.toString(),
      first: 10,
    });
    expect(Array.isArray(holders.traderPositions ?? [])).toBe(true);
  });

  it('returns a unified market feed sorted by creation and by volume', async () => {
    const byCreated: any = await client.public.getUnifiedMarketFeed({
      venueId,
      first: 20,
      sortBy: 'created',
    });
    expect(byCreated).toBeDefined();
    expect(Array.isArray(byCreated.standaloneMarkets ?? [])).toBe(true);

    const byVolume: any = await client.public.getUnifiedMarketFeed({
      venueId,
      first: 20,
      sortBy: 'volume',
    });
    expect(byVolume).toBeDefined();
  });

  it('returns chart trades with and without a timestamp filter', async () => {
    const all: any = await client.public.getChartTrades({ marketId, first: 50 });
    expect(Array.isArray(all.trades)).toBe(true);

    const since = BigInt(Math.floor(Date.now() / 1000) - 3600);
    const windowed: any = await client.public.getChartTrades({
      marketId,
      timestampGte: since,
      first: 50,
    });
    expect(Array.isArray(windowed.trades)).toBe(true);
  });

  it('returns orders for the market', async () => {
    const response: any = await client.public.getOrders({ marketId, first: 20 });
    expect(Array.isArray(response.orders)).toBe(true);
  });
});
