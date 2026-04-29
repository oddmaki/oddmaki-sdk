# OddMaki SDK

[![npm](https://img.shields.io/npm/v/@oddmaki-protocol/sdk)](https://www.npmjs.com/package/@oddmaki-protocol/sdk)

TypeScript SDK for the [OddMaki Protocol](https://github.com/oddmaki/oddmaki-core) — a fully on-chain prediction market factory on Base. Built on [viem](https://viem.sh/).

## Install

```bash
pnpm add @oddmaki-protocol/sdk viem
```

## Quick Start

```typescript
import { createOddMakiClient } from "@oddmaki-protocol/sdk";

const client = createOddMakiClient({
  walletClient, // viem WalletClient
});

// Read markets
const markets = await client.public.getMarkets(venueId);

// Place a limit order — buy YES at $0.65, 100 USDC, expires in 24h
await client.trade.placeOrderSimple(marketId, outcomeId, "buy", "0.65", "100", "24h");

// Place a market order (Fill-or-Kill)
await client.trade.placeMarketOrderSimple(marketId, outcomeId, "50", "0.70", 0);
```

## Modules

The client exposes functional modules covering the full protocol:

| Module | Purpose |
|---|---|
| `venue` | Create and configure venues (fee structure, access control, oracle params) |
| `market` | Create markets and market groups, read pricing and positions |
| `trade` | Limit orders, market orders (FOK/FAK), batch operations, split/merge |
| `public` | Subgraph queries — markets, trades, orderbook, analytics, leaderboards |
| `token` | ERC20 approvals and balance checks |
| `uma` | UMA oracle lifecycle — assert, settle, report, redeem |
| `accessControl` | Deploy and manage access control contracts (whitelist, NFT-gated, token-gated) |
| `priceMarket` | Pyth-powered price markets with automatic resolution |

## Trade API

Both raw and simplified interfaces are available. The simple API accepts human-readable strings:

```typescript
// Limit order
await client.trade.placeOrderSimple(marketId, outcomeId, "buy", "0.65", "100", "24h");

// Market order: spend 50 USDC, max price $0.70, Fill-or-Kill
await client.trade.placeMarketOrderSimple(marketId, outcomeId, "50", "0.70", 0);

// Batch: place up to 20 orders atomically
await client.trade.batchPlaceOrdersSimple(marketId, orders);

// Cancel and replace in a single transaction
await client.trade.cancelAndReplace(cancelIds, marketId, newOrders);
```

## Subgraph Queries

The `public` module provides indexed reads:

```typescript
// Unified feed (standalone markets + groups)
const feed = await client.public.getUnifiedMarketFeed(venueId);

// Trader profile and positions
const profile = await client.public.getTraderProfile(address);
const positions = await client.public.getTraderPositions(address);

// Leaderboard
const leaders = await client.public.getLeaderboard("totalVolume", "desc");
```

## Utilities

```typescript
import { priceToTick, tickToPrice, parseAmount } from "@oddmaki-protocol/sdk";

priceToTick("0.80");    // 80n
tickToPrice(80n);        // "0.80"
parseAmount("10.5");     // 10500000n (6 decimals)
```

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

## Related

- [oddmaki-core](https://github.com/oddmaki/oddmaki-core) — Smart contracts
- [oddmaki-subgraph](https://github.com/oddmaki/oddmaki-subgraph) — Subgraph
- [oddmaki-venue-starter](https://github.com/oddmaki/oddmaki-venue-starter) — Venue starter template

## Links

- **Protocol** — [oddmaki.com](https://oddmaki.com)
- **Company** — [predictablereality.com](https://predictablereality.com)
- **Contact** — team@oddmaki.com

## License

[MIT](./LICENSE) — Copyright (c) 2025-2026 Predictable Reality, Inc.