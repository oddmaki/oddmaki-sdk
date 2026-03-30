# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`@oddmaki/sdk` — TypeScript SDK for the OddMaki Protocol, a fully on-chain prediction market factory on Base. Built on viem.

## Commands

```bash
pnpm run build        # Build CJS + ESM + types via tsup
pnpm run dev          # Build in watch mode
pnpm run lint         # TypeScript type-check (tsc --noEmit)
pnpm run test         # Unit tests (vitest, excludes integration/)
pnpm run test:watch   # Unit tests in watch mode
pnpm run test:live    # Integration tests against live network (30s timeout)
```

## Architecture

### Client & Module Pattern

`OddMakiClient` (created via `createOddMakiClient()`) composes 8 modules, each extending `BaseModule`:

- **venue** — Create/configure venues, fee structure, access control, oracle params
- **market** — Create markets and groups, read pricing/positions, pause/unpause
- **trade** — Limit orders, market orders (FOK/FAK), batch (up to 20), split/merge positions
- **public** — Subgraph queries: markets, trades, orderbook, analytics, leaderboards
- **token** — ERC20 approvals, balances, metadata
- **uma** — UMA oracle lifecycle: assert → settle → report → redeem
- **accessControl** — Deploy whitelist, NFT-gated, or token-gated access contracts
- **priceMarket** — Pyth-powered price markets with automatic resolution

`BaseModule` provides shared access to viem `PublicClient` (reads), `WalletClient` (writes), `SubgraphClient` (indexed queries), and the config (contract addresses, chain, transport).

### Dual API Surface (Raw + Simple)

Most trade/market operations have two variants:
- **Raw**: Uses BigInt and protocol primitives (ticks, wei amounts)
- **Simple** (suffixed `Simple`): Accepts human-readable strings (`"0.80"` for price, `"100"` for amount, `"24h"` for expiry)

Conversion between them uses utilities in `src/utils/conversions.ts` and `src/utils/decimals.ts`.

### Key Conventions

- **Tick/price scale**: Ticks always use 1e18 scale. `priceToTick("0.80")` → `80n`. Tick sizes: `1e16` (1% standard) or `1e15` (0.1% fine).
- **Token decimals**: Amounts use collateral token decimals (e.g., 6 for USDC). `parseTokenAmount()` handles conversion with caching by `chainId-tokenAddress`.
- **Diamond pattern**: All write operations go through a single Diamond contract address. Multiple facets behind it handle different concerns. ABIs live in `src/contracts/abis/`.
- **Subgraph**: `PublicModule` reads from The Graph. Client wrapper in `src/subgraph/client.ts`, queries in `src/subgraph/queries.ts`.

### Contract Addresses (Base Sepolia)

Defined in `src/config.ts`. Diamond, ConditionalTokens, USDC, and subgraph endpoint. The SDK defaults to Base Sepolia if no chain is specified.

## Testing

- **Unit tests** in `test/modules/` — mock viem clients, test module logic
- **Integration tests** in `test/integration/` — hit live Base Sepolia network, excluded from default `pnpm run test`
- Framework: Vitest with globals enabled, Node environment
