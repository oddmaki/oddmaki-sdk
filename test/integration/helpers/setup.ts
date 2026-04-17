import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { http, decodeEventLog, type Hex, type TransactionReceipt, type Abi } from 'viem';
import { createOddMakiClient } from '../../../src/client';
import { CONTRACT_ADDRESSES } from '../../../src/config';
import type { OddMakiClient } from '../../../src/client';

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
  const key = process.env.ODDMAKI_TEST_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'ODDMAKI_TEST_PRIVATE_KEY env var is not set.\n' +
        'Set it to a Base Sepolia private key with ETH for gas.\n' +
        'MockUSD is minted on the fly — only testnet ETH is needed.\n' +
        'Example: ODDMAKI_TEST_PRIVATE_KEY=0xabc... pnpm run test:live',
    );
  }
  return privateKeyToAccount(key as Hex);
}

/**
 * Create an OddMakiClient wired to Base Sepolia with the test account.
 */
export function createTestClient(): OddMakiClient {
  const account = getTestAccount();
  return createOddMakiClient({
    account,
    chain: baseSepolia,
    transport: http(),
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
  return client.config.publicClient.waitForTransactionReceipt({ hash });
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
        return decoded.args as Record<string, unknown>;
      }
    } catch {
      // Log doesn't match this ABI — skip
    }
  }
  throw new Error(`Event "${eventName}" not found in transaction ${receipt.transactionHash}`);
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Mint MockUSD to the test account and approve the Diamond to spend it.
 * Waits for both transactions to be mined.
 */
export async function mintAndApproveUSDC(
  client: OddMakiClient,
  amount: bigint,
): Promise<void> {
  const account = getTestAccount();

  // Mint
  const mintHash = await client.token.mint(USDC_ADDRESS, account.address, amount);
  await waitForTx(client, mintHash);

  // Approve Diamond
  const approveHash = await client.token.approve(USDC_ADDRESS, DIAMOND_ADDRESS, amount);
  await waitForTx(client, approveHash);
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
