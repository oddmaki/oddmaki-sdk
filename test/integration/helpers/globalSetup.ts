import { parseUnits, parseEther } from 'viem';
import {
  hasTestAccount,
  createTestClient,
  getTestAccount,
  USDC_ADDRESS,
  ensureBalanceAndApprove,
  waitForTx,
  parseEventFromReceipt,
} from './setup';
import { waitForSubgraphSync } from './subgraph-sync';
import { writeSharedState } from './shared-state';
import { VenueFacetABI, MarketsFacetABI } from '../../../src/contracts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export async function setup() {
  if (!hasTestAccount()) {
    console.log(
      '\n⚠️  ODDMAKI_TEST_PRIVATE_KEY not set — skipping write-path integration test setup.\n' +
        '   Read-only tests (live.test.ts) will still run.\n' +
        '   Set the env var to a Base Sepolia private key with ETH for gas.\n',
    );
    return;
  }

  console.log('\n🔧 Integration test global setup: creating shared venue + market...\n');

  const client = createTestClient();
  const account = getTestAccount();

  // Assert the wallet is funded with enough USDC to cover the shared setup
  // (market creation fee = 5 USDC) plus headroom for child tests. Per-test
  // suites assert their own minimums on top of this.
  await ensureBalanceAndApprove(client, parseUnits('20', 6));

  // ---- Create venue ----
  const venueTxHash = await client.venue.createVenue({
    name: `Integration Test Venue ${Date.now()}`,
    metadata: '',
    tradingAccessControl: ZERO_ADDRESS,
    creationAccessControl: ZERO_ADDRESS,
    feeRecipient: account.address,
    venueFeeBps: 100, // 1%
    creatorFeeBps: 0,
    defaultTickSize: parseEther('0.01'), // 1% ticks
    marketCreationFee: parseUnits('5', 6), // 5 USDC
    umaRewardAmount: 0n,
    umaMinBond: parseUnits('1', 6), // 1 USDC — contract requires > 0
  });

  const venueReceipt = await waitForTx(client, venueTxHash);
  const venueArgs = parseEventFromReceipt(venueReceipt, VenueFacetABI as any, 'VenueCreated');
  const venueId = BigInt(venueArgs.venueId as bigint);
  console.log(`  ✓ Venue created: venueId=${venueId}`);

  // ---- Create binary market ----
  const marketTxHash = await client.market.createMarket({
    venueId,
    question: { title: 'Integration Test Market', description: 'Automated test market' },
    outcomes: ['Yes', 'No'],
    tickSize: parseEther('0.01'),
    collateralToken: USDC_ADDRESS,
    additionalReward: 0n,
    liveness: 0n,
  });

  const marketReceipt = await waitForTx(client, marketTxHash);
  const marketArgs = parseEventFromReceipt(marketReceipt, MarketsFacetABI as any, 'MarketCreated');
  const marketId = BigInt(marketArgs.marketId as bigint);
  console.log(`  ✓ Market created: marketId=${marketId}`);

  // Wait for subgraph to index
  console.log('  ⏳ Waiting for subgraph to index...');
  await waitForSubgraphSync(client, marketTxHash);
  console.log('  ✓ Subgraph synced\n');

  // Persist state for test files
  writeSharedState({
    venueId: venueId.toString(),
    marketId: marketId.toString(),
  });
}

export async function teardown() {
  // Nothing to clean up — test state lives on Base Sepolia
}
