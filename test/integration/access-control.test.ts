import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  hasTestAccount,
  waitForTx,
  parseEventFromReceipt,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createBinaryMarketFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { AccessControlFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Access control covers: factory deployment of the three AC variants, venue-
// level gating via venue config, and market-level overrides via
// setMarketTradingAC. We focus on WhitelistAccessControl because it's the only
// variant whose gating we can flip on the fly within a test run.
describe.skipIf(!hasTestAccount())('Access control', () => {
  let client: OddMakiClient;
  let whitelistAc: Address;
  let gatedVenueId: bigint;
  let gatedMarketId: bigint;
  // A separate, unfunded address to probe AC — the test account is the venue
  // operator, and operators bypass all AC checks by design.
  let outsider: Address;

  beforeAll(async () => {
    client = createTestClient();
    await ensureUsdcFunded(client, parseUnits('100', 6));

    // Random probe address (no key needed — we only pass it as an argument).
    outsider = privateKeyToAccount(generatePrivateKey()).address;

    // Deploy a WhitelistAccessControl contract — caller becomes the owner.
    const deployTx = await client.accessControl.deployWhitelist();
    const receipt = await waitForTx(client, deployTx);
    const deployed = parseEventFromReceipt(
      receipt,
      AccessControlFacetABI as any,
      'AccessControlDeployed',
    );
    whitelistAc = deployed.acContract as Address;

    // Create a venue gated by the whitelist for trading access.
    gatedVenueId = await createVenueFixture(client, {
      name: `Gated Venue ${Date.now()}`,
      tradingAccessControl: whitelistAc,
    });

    gatedMarketId = await createBinaryMarketFixture(client, gatedVenueId, {
      question: { title: 'Gated market', description: 'Gated by whitelist' },
    });
  });

  it('deploys a whitelist access-control contract with caller as owner', () => {
    expect(whitelistAc).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(whitelistAc.toLowerCase()).not.toBe(ZERO_ADDRESS);
  });

  it('respects the whitelist for venue-level trading access', async () => {
    // Outsider isn't on the whitelist → canTrade must be false.
    let allowed = await client.accessControl.isWhitelisted({
      acContract: whitelistAc,
      user: outsider,
    });
    expect(allowed).toBe(false);
    expect(await client.venue.canTrade(outsider, gatedVenueId)).toBe(false);

    // Add to whitelist.
    const addTx = await client.accessControl.addToWhitelist({
      acContract: whitelistAc,
      users: [outsider],
    });
    await waitForTx(client, addTx);

    allowed = await client.accessControl.isWhitelisted({
      acContract: whitelistAc,
      user: outsider,
    });
    expect(allowed).toBe(true);
    expect(await client.venue.canTrade(outsider, gatedVenueId)).toBe(true);

    // Remove and re-check.
    const removeTx = await client.accessControl.removeFromWhitelist({
      acContract: whitelistAc,
      users: [outsider],
    });
    await waitForTx(client, removeTx);

    expect(
      await client.accessControl.isWhitelisted({
        acContract: whitelistAc,
        user: outsider,
      }),
    ).toBe(false);
    expect(await client.venue.canTrade(outsider, gatedVenueId)).toBe(false);
  });

  it('supports market-level AC overrides via setMarketTradingAC', async () => {
    // With no override, market inherits venue-level AC (outsider: blocked).
    expect(
      await client.accessControl.canTradeOnMarket({
        user: outsider,
        marketId: gatedMarketId,
      }),
    ).toBe(false);

    // Override with a NEW whitelist that includes the outsider.
    const newAcTx = await client.accessControl.deployWhitelist();
    const newAcReceipt = await waitForTx(client, newAcTx);
    const newAc = (
      parseEventFromReceipt(
        newAcReceipt,
        AccessControlFacetABI as any,
        'AccessControlDeployed',
      ).acContract as Address
    );

    const addTx = await client.accessControl.addToWhitelist({
      acContract: newAc,
      users: [outsider],
    });
    await waitForTx(client, addTx);

    const setTx = await client.accessControl.setMarketTradingAC({
      marketId: gatedMarketId,
      acContract: newAc,
    });
    await waitForTx(client, setTx);

    expect(
      await client.accessControl.getMarketTradingAC({ marketId: gatedMarketId }),
    ).toBe(newAc);
    expect(
      await client.accessControl.canTradeOnMarket({
        user: outsider,
        marketId: gatedMarketId,
      }),
    ).toBe(true);

    // Remove override — market falls back to venue-level (outsider blocked again).
    const removeTx = await client.accessControl.removeMarketTradingAC({
      marketId: gatedMarketId,
    });
    await waitForTx(client, removeTx);
    expect(
      await client.accessControl.getMarketTradingAC({ marketId: gatedMarketId }),
    ).toBe(ZERO_ADDRESS);
    expect(
      await client.accessControl.canTradeOnMarket({
        user: outsider,
        marketId: gatedMarketId,
      }),
    ).toBe(false);
  });

  it('deploys a token-gated access-control contract', async () => {
    // Just verify deployment works; we don't exercise the gate itself because
    // flipping a user's token balance mid-test is out of scope.
    const tx = await client.accessControl.deployTokenGated({
      token: '0x9a537902b0456ce532ee58859a0e9db47c647668',
      minBalance: parseUnits('1', 6),
    });
    const receipt = await waitForTx(client, tx);
    const deployed = parseEventFromReceipt(
      receipt,
      AccessControlFacetABI as any,
      'AccessControlDeployed',
    );
    expect(deployed.acContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
