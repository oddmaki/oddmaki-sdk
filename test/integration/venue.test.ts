import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits, parseEther } from 'viem';
import {
  hasTestAccount,
  createTestClient,
  getTestAccount,
  mintAndApproveUSDC,
  waitForTx,
  parseEventFromReceipt,
  USDC_ADDRESS,
} from './helpers/setup';
import { waitForSubgraphSync } from './helpers/subgraph-sync';
import { VenueFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

describe.skipIf(!hasTestAccount())('Venue lifecycle', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let lastTxHash: `0x${string}`;

  beforeAll(async () => {
    client = createTestClient();

    // Mint USDC for market creation fees (venue creation itself is gas-only)
    await mintAndApproveUSDC(client, parseUnits('100', 6));

    const account = getTestAccount();
    const txHash = await client.venue.createVenue({
      name: `Venue Test ${Date.now()}`,
      metadata: 'integration-test',
      tradingAccessControl: ZERO_ADDRESS,
      creationAccessControl: ZERO_ADDRESS,
      feeRecipient: account.address,
      venueFeeBps: 50, // 0.5%
      creatorFeeBps: 25, // 0.25%
      defaultTickSize: parseEther('0.01'),
      marketCreationFee: parseUnits('5', 6),
      umaRewardAmount: 0n,
      umaMinBond: parseUnits('1', 6), // 1 USDC — contract requires > 0
    });

    const receipt = await waitForTx(client, txHash);
    const args = parseEventFromReceipt(receipt, VenueFacetABI as any, 'VenueCreated');
    venueId = BigInt(args.venueId as bigint);
    lastTxHash = txHash;

    console.log(`  Venue created: venueId=${venueId}, tx=${txHash}`);
  });

  it('should read venue back on-chain with correct parameters', async () => {
    const venue: any = await client.venue.getVenue(venueId);

    expect(venue).toBeDefined();
    expect(BigInt(venue.venueFeeBps)).toBe(50n);
    expect(BigInt(venue.creatorFeeBps)).toBe(25n);
    expect(BigInt(venue.defaultTickSize)).toBe(parseEther('0.01'));
    expect(BigInt(venue.marketCreationFee)).toBe(parseUnits('5', 6));
  });

  it('should appear in subgraph after indexing', async () => {
    await waitForSubgraphSync(client, lastTxHash);

    const response = (await client.public.getVenues()) as any;

    expect(response.venues).toBeDefined();
    expect(Array.isArray(response.venues)).toBe(true);

    const found = response.venues.find(
      (v: any) => v.venueId === venueId.toString(),
    );
    expect(found).toBeDefined();
    expect(found.name).toContain('Venue Test');
  });

  it('should allow open access for trading and market creation', async () => {
    const account = getTestAccount();

    const canTrade = await client.venue.canTrade(account.address, venueId);
    expect(canTrade).toBe(true);

    const canCreate = await client.venue.canCreateMarket(account.address, venueId);
    expect(canCreate).toBe(true);
  });
});
