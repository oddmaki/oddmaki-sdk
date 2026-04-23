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

  it('should update fees via updateFees', async () => {
    const tx = await client.venue.updateFees({
      venueId,
      venueFeeBps: 75,
      creatorFeeBps: 40,
    });
    await waitForTx(client, tx);

    const venue: any = await client.venue.getVenue(venueId);
    expect(BigInt(venue.venueFeeBps)).toBe(75n);
    expect(BigInt(venue.creatorFeeBps)).toBe(40n);
  });

  it('should update oracle params via updateOracleParams', async () => {
    const newMinBond = parseUnits('2', 6);
    const tx = await client.venue.updateOracleParams({
      venueId,
      umaRewardAmount: 0n,
      umaMinBond: newMinBond,
    });
    await waitForTx(client, tx);

    const venue: any = await client.venue.getVenue(venueId);
    expect(BigInt(venue.umaMinBond)).toBe(newMinBond);
  });

  it('should update name, metadata, and fee recipient via updateVenue', async () => {
    const account = getTestAccount();
    const newName = `Venue Test Updated ${Date.now()}`;
    const tx = await client.venue.updateVenue({
      venueId,
      name: newName,
      metadata: 'updated-metadata',
      tradingAccessControl: ZERO_ADDRESS,
      creationAccessControl: ZERO_ADDRESS,
      feeRecipient: account.address,
    });
    await waitForTx(client, tx);

    const venue: any = await client.venue.getVenue(venueId);
    expect(venue.name).toBe(newName);
    expect(venue.metadata).toBe('updated-metadata');
  });

  it('should pause and unpause the venue via setPaused', async () => {
    const pauseTx = await client.venue.setPaused(venueId, true);
    await waitForTx(client, pauseTx);

    const account = getTestAccount();
    // Paused venues block trading and market creation.
    expect(await client.venue.canTrade(account.address, venueId)).toBe(false);
    expect(await client.venue.canCreateMarket(account.address, venueId)).toBe(false);

    const unpauseTx = await client.venue.setPaused(venueId, false);
    await waitForTx(client, unpauseTx);

    expect(await client.venue.canTrade(account.address, venueId)).toBe(true);
    expect(await client.venue.canCreateMarket(account.address, venueId)).toBe(true);
  });

  it('should read protocol fee bps via getProtocolFeeBps', async () => {
    const bps = await client.venue.getProtocolFeeBps();
    // Protocol fee has a max of 200 bps per validator; anything beyond that is a misconfig.
    expect(bps).toBeGreaterThanOrEqual(0n);
    expect(bps).toBeLessThanOrEqual(200n);
  });
});
