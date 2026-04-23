import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import {
  hasTestAccount,
  getTestAccount,
  waitForTx,
  parseEventFromReceipt,
  approveCTFForDiamond,
  USDC_ADDRESS,
} from './helpers/setup';
import {
  createTestClient,
  createVenueFixture,
  createBinaryMarketFixture,
  ensureUsdcFunded,
} from './helpers/fixtures';
import { ResolutionFacetABI } from '../../src/contracts';
import type { OddMakiClient } from '../../src/client';

// Focused UMA coverage. The full assert → settle → report → redeem flow cannot
// be exercised in a reasonable test runtime because the protocol floors UMA
// liveness at 2h (LibOracleInitializationService.MIN_LIVENESS). We cover the
// reachable surface:
//   - bond/oracle reads (getEffectiveBond, getMarketStatus, getQuestionData)
//   - assertMarketOutcome happy path + bond escrow + event decoding
//   - getAssertionDetails on a fresh assertion
// Settle/report/redeem are left as skipped, documented for manual runs.
describe.skipIf(!hasTestAccount())('UMA resolution (reachable surface)', () => {
  let client: OddMakiClient;
  let venueId: bigint;
  let marketId: bigint;
  let assertionId: `0x${string}` | null = null;

  beforeAll(async () => {
    client = createTestClient();

    // Generous mint: market creation fee + bond (UMA minimum can exceed our
    // venue's umaMinBond) + outcome tokens for follow-on tests.
    await ensureUsdcFunded(client, parseUnits('500', 6));
    await approveCTFForDiamond(client);

    venueId = await createVenueFixture(client, {
      name: `UMA Test Venue ${Date.now()}`,
    });

    marketId = await createBinaryMarketFixture(client, venueId, {
      question: {
        title: 'UMA Test Market',
        description: 'Market used to probe UMA lifecycle',
      },
    });
  });

  it('reports effective bond from UMA oracle', async () => {
    const { requiredBond, minimumBond, effectiveBond, currency } =
      await client.uma.getEffectiveBond(marketId);
    expect(currency.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(effectiveBond).toBe(
      requiredBond > minimumBond ? requiredBond : minimumBond,
    );
    expect(effectiveBond).toBeGreaterThan(0n);
  });

  it('returns shape-consistent data from getMarketStatus and getQuestionData', async () => {
    const status: any = await client.uma.getMarketStatus(marketId);
    expect(status).toBeDefined();

    const question: any = await client.uma.getQuestionData(marketId);
    expect(question).toBeDefined();
    // questionId is the join key to UMA assertions — must be present.
    expect(question.questionId ?? status.questionId).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('asserts an outcome, escrows the bond, and emits AssertionCreated', async () => {
    const account = getTestAccount();

    const { effectiveBond } = await client.uma.getEffectiveBond(marketId);
    const usdcBefore = await client.token.getBalance(USDC_ADDRESS, account.address);

    const assertTx = await client.uma.assertMarketOutcome({
      marketId,
      outcome: 'Yes',
      autoApprove: true,
    });
    const assertReceipt = await waitForTx(client, assertTx);

    const args = parseEventFromReceipt(
      assertReceipt,
      ResolutionFacetABI as any,
      'AssertionCreated',
    );
    assertionId = args.assertionId as `0x${string}`;
    expect(assertionId).toMatch(/^0x[0-9a-f]{64}$/i);

    // Bond was escrowed — USDC balance drops by at least the effective bond.
    // (Additional market-creation reward / fee already happened earlier.)
    const usdcAfter = await client.token.getBalance(USDC_ADDRESS, account.address);
    expect(usdcBefore - usdcAfter).toBeGreaterThanOrEqual(effectiveBond);
  });

  it('reads assertion details via UMA oracle directly', async () => {
    expect(assertionId).not.toBeNull();
    const details: any = await client.uma.getAssertionDetails(assertionId!);
    expect(details).toBeDefined();
    // isDisputed should be false immediately after assertion.
    expect(details.isDisputed ?? false).toBe(false);
  });

  // Full settle + report + redeem requires waiting MIN_LIVENESS (2h) plus
  // subgraph indexing; not appropriate for a CI test. Kept here so it's easy
  // to flip to `it(...)` for manual verification against a long-lived market.
  it.skip('settles, reports, and redeems after UMA liveness elapses (manual)', async () => {
    expect(assertionId).not.toBeNull();
    const account = getTestAccount();

    const settleTx = await client.uma.settleAssertion(assertionId!);
    await waitForTx(client, settleTx);

    const reportTx = await client.uma.reportResolution({
      marketId,
      outcome: 'Yes',
    });
    await waitForTx(client, reportTx);

    const resolution: any = await client.uma.getResolutionStatus(marketId);
    expect(resolution.resolved ?? true).toBeTruthy();

    const redeemTx = await client.uma.redeemWinnings(marketId);
    await waitForTx(client, redeemTx);

    const usdcAfter = await client.token.getBalance(USDC_ADDRESS, account.address);
    expect(usdcAfter).toBeGreaterThan(0n);
  });
});
