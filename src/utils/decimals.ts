import type { PublicClient, Address } from 'viem';
import { parseAmount } from './conversions';

/**
 * Decimal handling utilities for ERC20 tokens
 *
 * IMPORTANT: The OddMaki Protocol uses 1e18 for all internal price calculations,
 * but collateral tokens (like USDC) may use different decimals (e.g., 6).
 *
 * This module provides utilities to correctly handle token decimals when
 * converting between user-facing amounts and contract values.
 */

/**
 * Get the number of decimals for an ERC20 token
 * @param publicClient - Viem public client
 * @param token - Token address
 * @returns Number of decimals (e.g., 6 for USDC, 18 for most ERC20s)
 *
 * @example
 * const decimals = await getTokenDecimals(publicClient, usdcAddress);
 * console.log(decimals); // 6
 */
export async function getTokenDecimals(
  publicClient: PublicClient,
  token: Address
): Promise<number> {
  const decimals = await publicClient.readContract({
    address: token,
    abi: [
      {
        name: 'decimals',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint8' }],
      },
    ],
    functionName: 'decimals',
  });

  return Number(decimals);
}

/**
 * Parse a token amount string with validation
 * @param amount - Amount as decimal string (e.g., "10.5")
 * @param decimals - Token decimals (e.g., 6 for USDC, 18 for most tokens)
 * @returns BigInt in smallest unit
 * @throws Error if decimals are invalid
 *
 * @example
 * parseTokenAmount("10.5", 6)  // 10500000n (USDC)
 * parseTokenAmount("10.5", 18) // 10500000000000000000n (ETH-like)
 */
export function parseTokenAmount(
  amount: string,
  decimals: number
): bigint {
  if (decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}. Must be between 0 and 18.`);
  }

  if (!amount || amount.trim() === '') {
    throw new Error('Amount cannot be empty');
  }

  return parseAmount(amount, decimals);
}

/**
 * Cache for token decimals to avoid redundant RPC calls
 * Key format: `${chainId}-${tokenAddress.toLowerCase()}`
 */
const decimalsCache = new Map<string, number>();

/**
 * Get token decimals with caching to reduce RPC calls
 * @param publicClient - Viem public client
 * @param token - Token address
 * @returns Number of decimals
 *
 * @example
 * // First call hits RPC
 * const decimals1 = await getCachedTokenDecimals(publicClient, usdcAddress);
 *
 * // Second call uses cache
 * const decimals2 = await getCachedTokenDecimals(publicClient, usdcAddress);
 */
export async function getCachedTokenDecimals(
  publicClient: PublicClient,
  token: Address
): Promise<number> {
  const chainId = await publicClient.getChainId();
  const cacheKey = `${chainId}-${token.toLowerCase()}`;

  const cached = decimalsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const decimals = await getTokenDecimals(publicClient, token);
  decimalsCache.set(cacheKey, decimals);

  return decimals;
}

/**
 * Clear the decimals cache (useful for testing or switching networks)
 */
export function clearDecimalsCache(): void {
  decimalsCache.clear();
}
