import type { Hex } from 'viem';
import { SubgraphClient } from '../../../src/subgraph/client';
import { SUBGRAPH_ENDPOINT } from './setup';
import type { OddMakiClient } from '../../../src/client';

const META_QUERY = `{ _meta { block { number } } }`;

const subgraphClient = new SubgraphClient(SUBGRAPH_ENDPOINT);

/**
 * Wait for the subgraph to index the block containing a transaction.
 *
 * 1. Gets the block number from the tx receipt.
 * 2. Polls the subgraph's _meta endpoint until it has indexed that block.
 * 3. Throws if the timeout is exceeded.
 */
export async function waitForSubgraphSync(
  client: OddMakiClient,
  txHash: Hex,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<void> {
  const { timeoutMs = 60_000, pollIntervalMs = 2_000 } = opts ?? {};

  const receipt = await client.config.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  const targetBlock = receipt.blockNumber;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await subgraphClient.request<{
        _meta: { block: { number: number } };
      }>(META_QUERY);

      if (BigInt(result._meta.block.number) >= targetBlock) {
        return;
      }
    } catch {
      // Subgraph may be temporarily unavailable — keep polling
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Subgraph did not index block ${targetBlock} within ${timeoutMs}ms`,
  );
}
