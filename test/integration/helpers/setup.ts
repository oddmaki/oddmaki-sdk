import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { formatUnits, http, decodeEventLog, type Hex, type TransactionReceipt, type Abi } from 'viem';
import { createOddMakiClient } from '../../../src/client';
import { CONTRACT_ADDRESSES } from '../../../src/config';
import type { OddMakiClient } from '../../../src/client';

const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';

// ---------------------------------------------------------------------------
// Addresses (re-exported from SDK config for convenience)
// ---------------------------------------------------------------------------

const addresses = CONTRACT_ADDRESSES[baseSepolia.id];
export const USDC_ADDRESS = addresses.usdc;
export const DIAMOND_ADDRESS = addresses.diamond;
export const CTF_ADDRESS = addresses.conditionalTokens;
export const SUBGRAPH_ENDPOINT = addresses.subgraph;

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

/**
 * Check if a test private key is available in the environment.
 * Used by test files to skip write-path suites gracefully.
 */
export function hasTestAccount(): boolean {
  return !!process.env.ODDMAKI_TEST_PRIVATE_KEY;
}

/**
 * Get the test account from the environment variable.
 * Throws if ODDMAKI_TEST_PRIVATE_KEY is not set — callers should
 * check hasTestAccount() first.
 */
export function getTestAccount() {
  const raw = process.env.ODDMAKI_TEST_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      'ODDMAKI_TEST_PRIVATE_KEY env var is not set.\n' +
        'Set it to a Base Sepolia private key with:\n' +
        '  - ETH for gas\n' +
        `  - USDC for collateral (get it from ${CIRCLE_FAUCET_URL})\n` +
        'Example: ODDMAKI_TEST_PRIVATE_KEY=0xabc... pnpm run test:live',
    );
  }
  const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(key);
}

/**
 * Create an OddMakiClient wired to Base Sepolia with the test account.
 */
export function createTestClient(): OddMakiClient {
  const account = getTestAccount();
  const rpcUrl = process.env.ODDMAKI_TEST_RPC_URL;
  return createOddMakiClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a transaction to be mined and return the receipt.
 */
export async function waitForTx(
  client: OddMakiClient,
  hash: Hex,
): Promise<TransactionReceipt> {
  // confirmations: 2 lets load-balanced RPC read replicas catch up so a
  // follow-up read on the same contract doesn't hit a lagging node.
  return client.config.publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
}

/**
 * Parse an event from a transaction receipt and return the first match's args.
 * Used to extract venueId, marketId, orderId, etc. from creation tx receipts.
 */
export function parseEventFromReceipt(
  receipt: TransactionReceipt,
  abi: Abi,
  eventName: string,
): Record<string, unknown> {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === eventName) {
        return decoded.args as unknown as Record<string, unknown>;
      }
    } catch {
      // Log doesn't match this ABI — skip
    }
  }
  throw new Error(`Event "${eventName}" not found in transaction ${receipt.transactionHash}`);
}

/**
 * Parse every occurrence of a given event name from a receipt.
 * Returns args in log-order; empty array if none match.
 */
export function parseAllEventsFromReceipt(
  receipt: TransactionReceipt,
  abi: Abi,
  eventName: string,
): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === eventName) {
        results.push(decoded.args as unknown as Record<string, unknown>);
      }
    } catch {
      // Log doesn't match this ABI — skip
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Assert the test account holds at least `amount` of (real) USDC and ensure the
 * Diamond is approved to spend at least that much. Throws with faucet instructions
 * if the wallet is underfunded. Idempotent — approves only when current allowance
 * is below `amount`.
 */
export async function ensureBalanceAndApprove(
  client: OddMakiClient,
  amount: bigint,
): Promise<void> {
  const account = getTestAccount();

  const balance = await client.token.getBalance(USDC_ADDRESS, account.address);
  if (balance < amount) {
    throw new Error(
      `Test wallet ${account.address} has insufficient USDC on Base Sepolia.\n` +
        `  required: ${formatUnits(amount, 6)} USDC\n` +
        `  balance:  ${formatUnits(balance, 6)} USDC\n` +
        `Fund the wallet from ${CIRCLE_FAUCET_URL} (select Base Sepolia) before re-running.`,
    );
  }

  const allowance = await client.token.getAllowance(USDC_ADDRESS, account.address, DIAMOND_ADDRESS);
  if (allowance < amount) {
    const approveHash = await client.token.approve(USDC_ADDRESS, DIAMOND_ADDRESS, amount);
    await waitForTx(client, approveHash);
  }
}

// Inline ABI fragment for CTF setApprovalForAll (not in the SDK's ConditionalTokens ABI)
const SET_APPROVAL_FOR_ALL_ABI = [
  {
    name: 'setApprovalForAll',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

/**
 * Approve the Diamond to transfer CTF (ERC-1155) outcome tokens on behalf of the test account.
 * Required before merge operations and sell orders.
 */
export async function approveCTFForDiamond(client: OddMakiClient): Promise<void> {
  const account = getTestAccount();

  const hash = await client.config.walletClient!.writeContract({
    address: CTF_ADDRESS,
    abi: SET_APPROVAL_FOR_ALL_ABI,
    functionName: 'setApprovalForAll',
    args: [DIAMOND_ADDRESS, true],
    account,
    chain: baseSepolia,
  });
  await waitForTx(client, hash);
}
