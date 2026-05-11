import { parseUnits, parseEther, type Address } from 'viem';
import {
  createTestClient,
  getTestAccount,
  USDC_ADDRESS,
  ensureBalanceAndApprove,
  waitForTx,
  parseEventFromReceipt,
} from './setup';
import {
  VenueFacetABI,
  MarketsFacetABI,
  MarketGroupFacetABI,
  PythResolutionFacetABI,
} from '../../../src/contracts';
import type { OddMakiClient } from '../../../src/client';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface VenueFixtureOpts {
  name?: string;
  venueFeeBps?: number;
  creatorFeeBps?: number;
  marketCreationFee?: bigint;
  umaRewardAmount?: bigint;
  umaMinBond?: bigint;
  tradingAccessControl?: Address;
  creationAccessControl?: Address;
  feeRecipient?: Address;
}

// Create a venue with sensible defaults and return its id.
export async function createVenueFixture(
  client: OddMakiClient,
  opts: VenueFixtureOpts = {},
): Promise<bigint> {
  const account = getTestAccount();

  const txHash = await client.venue.createVenue({
    name: opts.name ?? `Fixture Venue ${Date.now()}`,
    metadata: '',
    tradingAccessControl: opts.tradingAccessControl ?? ZERO_ADDRESS,
    creationAccessControl: opts.creationAccessControl ?? ZERO_ADDRESS,
    feeRecipient: opts.feeRecipient ?? account.address,
    venueFeeBps: opts.venueFeeBps ?? 100,
    creatorFeeBps: opts.creatorFeeBps ?? 0,
    defaultTickSize: parseEther('0.01'),
    marketCreationFee: opts.marketCreationFee ?? parseUnits('5', 6),
    umaRewardAmount: opts.umaRewardAmount ?? 0n,
    umaMinBond: opts.umaMinBond ?? parseUnits('1', 6),
  });
  const receipt = await waitForTx(client, txHash);
  const args = parseEventFromReceipt(receipt, VenueFacetABI as any, 'VenueCreated');
  return BigInt(args.venueId as bigint);
}

export interface BinaryMarketFixtureOpts {
  question?: { title: string; description: string };
  outcomes?: string[];
  liveness?: bigint;
  additionalReward?: bigint;
}

// Create a binary market on a venue and return its id.
export async function createBinaryMarketFixture(
  client: OddMakiClient,
  venueId: bigint,
  opts: BinaryMarketFixtureOpts = {},
): Promise<bigint> {
  const txHash = await client.market.createMarket({
    venueId,
    question: opts.question ?? {
      title: `Fixture Market ${Date.now()}`,
      description: 'Fixture',
    },
    outcomes: opts.outcomes ?? ['Yes', 'No'],
    tickSize: parseEther('0.01'),
    collateralToken: USDC_ADDRESS,
    additionalReward: opts.additionalReward ?? 0n,
    liveness: opts.liveness ?? 0n,
  });
  const receipt = await waitForTx(client, txHash);
  const args = parseEventFromReceipt(receipt, MarketsFacetABI as any, 'MarketCreated');
  return BigInt(args.marketId as bigint);
}

// Ensure the test account has at least `amount` of USDC and the Diamond is
// approved for that much. Pre-fund the wallet from https://faucet.circle.com.
export async function ensureUsdcFunded(
  client: OddMakiClient,
  amount: bigint,
): Promise<void> {
  await ensureBalanceAndApprove(client, amount);
}

// Re-export the underlying client builder for convenience.
export { createTestClient };

export interface MarketGroupFixtureOpts {
  title?: string;
  description?: string;
  marketNames?: string[];
  liveness?: bigint;
  additionalReward?: bigint;
}

// Create and activate a market group with N live markets. Returns groupId
// plus the market ids (in add order). Each market is a binary Yes/No child.
export async function createActivatedMarketGroupFixture(
  client: OddMakiClient,
  venueId: bigint,
  marketCount: number,
  opts: MarketGroupFixtureOpts = {},
): Promise<{ groupId: bigint; marketIds: bigint[]; lastTxHash: `0x${string}` }> {
  const title = opts.title ?? `Fixture Group ${Date.now()}`;
  const description = opts.description ?? 'Fixture group';
  const names =
    opts.marketNames ?? Array.from({ length: marketCount }, (_, i) => `Option ${i + 1}`);

  const groupTx = await client.market.createMarketGroup({
    venueId,
    question: title,
    description,
    tickSize: parseEther('0.01'),
    collateralToken: USDC_ADDRESS,
    additionalReward: opts.additionalReward ?? 0n,
    liveness: opts.liveness ?? 0n,
  });
  const groupReceipt = await waitForTx(client, groupTx);
  const groupArgs = parseEventFromReceipt(
    groupReceipt,
    MarketGroupFacetABI as any,
    'MarketGroupCreated',
  );
  const groupId = BigInt(groupArgs.groupId as bigint);

  const marketIds: bigint[] = [];
  let lastTxHash = groupTx;
  for (const marketName of names) {
    const addTx = await client.market.addMarketToGroup({
      marketGroupId: groupId,
      marketName,
      marketQuestion: marketName,
    });
    const addReceipt = await waitForTx(client, addTx);
    const addArgs = parseEventFromReceipt(
      addReceipt,
      MarketsFacetABI as any,
      'MarketCreated',
    );
    marketIds.push(BigInt(addArgs.marketId as bigint));
    lastTxHash = addTx;
  }

  const activateTx = await client.market.activateMarketGroup({ marketGroupId: groupId });
  await waitForTx(client, activateTx);
  lastTxHash = activateTx;

  return { groupId, marketIds, lastTxHash };
}

export interface PythStrikeMarketFixtureOpts {
  pythFeedId?: `0x${string}`;
  strikePrice?: bigint;
  closeTime?: bigint;
  outcomes?: string[];
  liveness?: bigint;
}

// ETH/USD Pyth feed id — stable across Pyth deployments.
export const ETH_USD_PYTH_FEED =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' as const;

export async function createPythStrikeMarketFixture(
  client: OddMakiClient,
  venueId: bigint,
  opts: PythStrikeMarketFixtureOpts = {},
): Promise<{ marketId: bigint; closeTime: bigint; txHash: `0x${string}` }> {
  const closeTime =
    opts.closeTime ?? BigInt(Math.floor(Date.now() / 1000)) + 360n;
  const txHash = await client.priceMarket.createPyth({
    venueId,
    pythFeedId: opts.pythFeedId ?? ETH_USD_PYTH_FEED,
    strikePrice: opts.strikePrice ?? parseUnits('3000', 8),
    closeTime,
    outcomes: opts.outcomes ?? ['Above', 'Below'],
    tickSize: parseEther('0.01'),
    collateralToken: USDC_ADDRESS,
    question: {
      title: `Fixture Price Market ${Date.now()}`,
      description: 'Fixture price market',
    },
    liveness: opts.liveness ?? 0n,
  });
  const receipt = await waitForTx(client, txHash);
  const args = parseEventFromReceipt(
    receipt,
    PythResolutionFacetABI as any,
    'MarketCreated',
  );
  return { marketId: BigInt(args.marketId as bigint), closeTime, txHash };
}
